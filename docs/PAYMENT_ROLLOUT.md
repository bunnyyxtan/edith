# Payment guard rollout and recovery

This is an operator runbook, not evidence that production has been reconciled. No production read, database migration, deployment or payment was performed while preparing this branch. Do not enable legacy wallets by setting a blanket flag. Missing history remains a release blocker for those wallets.

## 1. Maintenance cutover and writer fence

1. Inventory every writer to the production Neon database: current Vercel deployment, immutable deployment URLs, previews, rollbacks, workers and local processes. Confirm the database and Sui network. Use a separate database for previews. Back up `edith_users`, `edith_plans` and `edith_used_digests` with timestamps before migration; retain an access-controlled copy outside the app's capped history.
2. Block new payment submissions on ALL old deployments and stop other writers. Drain in-flight requests; Vercel's configured maximum is 300 seconds, so allow at least six minutes after admission stops and confirm no running jobs. This is not evidence that previously handed-off signatures are invalid. Include all interrupted requests in reconciliation. Do not rely only on moving the production alias or waiting for quote expiry.
3. Using the reviewed release and the correct database, have an authorized operator run `migrate(pgDb(pool))` from `src/state.mjs`, then close the pool. The normal new-handler startup does this too. The first installation creates the PL/pgSQL function and trigger in an advisory-locked transaction. Later cold starts inspect the existing fence and skip function/trigger DDL when it matches; a disabled or altered fence fails startup for operator review. The role must own the table / have the necessary function and trigger privileges for installation. If migration fails, the new Vercel handler returns 503 and must not be bypassed. Migration changes no existing wallet JSON and certifies no historical records.
4. Verify the fence below and test a legacy-style write in a transaction that is always rolled back. Expect `EDITH wallet writer is obsolete`. New `pgStore.update` must succeed in an isolated staging database. Never set the writer marker at session, role, or database scope; the app sets it locally inside each transaction. Never disable the trigger or restore an unfenced database to make an old deployment work.
5. Reconcile legacy wallets as below, then admit requests only to the guarded deployment after approval. Retire old endpoints/credentials. The fence stops old *future* wallet writes, but cannot recall a signature that an old request already transmitted. Rollback is to another guarded release; if unavailable, pause payments rather than remove the fence.

Fence inspection (read-only):

```sql
SELECT tgname, tgenabled, pg_get_triggerdef(oid)
FROM pg_trigger WHERE tgrelid = 'edith_users'::regclass AND NOT tgisinternal;
SELECT pg_get_functiondef('edith_guard_wallet_writer()'::regprocedure);
SELECT current_setting('edith.payment_writer', true); -- must not be '2' outside a guarded transaction
```

For a controlled legacy-write probe, run `BEGIN; UPDATE edith_users SET updated_at = updated_at WHERE address = '<existing-wallet>';` without setting a marker; expect an error, then `ROLLBACK;`. Verify the wallet exists first. Do not probe by submitting a payment.

The fence is enforced by Postgres, not an instance's cache. `set_config(..., true)`, the row lock and the update share one transaction on one `pg` client. Transaction-local settings and transaction-level advisory locks work with transaction pooling; no session affinity is needed. PGlite regressions cover the SQL, rollback behavior and repeated startup without fence DDL. The actual Neon role privileges, catalog visibility, pooler, concurrent cold starts and Vercel routing still need operator validation on an isolated staging database before production. Confirm repeated starts leave the installed trigger unchanged and old writes still fail. Never attach an unapproved preview to production just to test startup: startup installs the fence. An unexpected function body/trigger definition must be reviewed against this release, not automatically overwritten to clear the startup error.

File-backed local installations: stop ALL old processes before opening the data directory with this release. There is no cross-version filesystem fence or multi-process lock. Existing files get the same history hold; new files get the guarded-creation marker. Hosted Vercel continues to require Neon.

## 2. Evidence-backed historical reconciliation

Every existing wallet lacking `paymentHistory.version = 1` remains held for new payments. Retained activity is not a complete journal. Ordinary requests and limit changes never approve this history. Newly created wallet records under the fence carry `basis: "created-with-guards"`; do not apply that basis to imported or existing records.

For each legacy wallet, the operator must:

1. Export its complete JSONB row and all matching plans, backups and retained provider/application records, with the cutover timestamp and network. Enumerate every EDITH signature handed off over its entire history, not just transactions that appear on chain. Check interruptions and legacy `refused` entries. `scripts/verify-evidence.mjs` checks some known local records; it is NOT a Neon backfill or completeness proof.
2. Cross-check transaction digests against Sui through the configured gateway; obtain archival data where required. Capture digest, sender, recipient, native-SUI amount, effects, checkpoint and settlement timestamp. Record the source and completeness bounds of each export. A chain-only scan cannot discover a signature that has never been submitted. If the handoff inventory is incomplete, do not certify the wallet.
3. Prepare a reviewed copy of the wallet JSON. Preserve limits, agents, activity and existing holds. Merge independently evidenced recent paid records into `spending`; include every payment settled in the rolling 24 hours at enablement, with its actual `verifiedAt`. Retain all unconfirmed/settling signatures irrespective of age. Restore known missing uncertain items into both `activity` and `spending` so they can be rechecked. Include original request ID where known, `digest`, `amountMist`, `terms` (`payTo`, `amount`), original `at`, and the evidenced context. Never guess missing fields or create synthetic payments to approximate a total. If necessary context/amount cannot be recovered, keep the wallet held and escalate for manual review.
4. Deduplicate proven duplicate records by actual transaction identity; do not merge distinct signatures or remove an uncertain record just because its amount matches a settled transfer. Preserve definitive failures/invalidation evidence. Check totals independently against the authoritative evidence, including late settlement. Keep the evidence bundle and reviewed diff outside the application's rolling ledger, with reviewer, timestamp, network and a content hash.
5. Only when the inventory is complete and the ledger is correct, add this metadata to the reviewed copy (real values required):

```json
{
  "paymentHistory": {
    "version": 1,
    "basis": "reconciled",
    "evidenceRef": "<access-controlled evidence bundle identifier and hash>",
    "reviewedAt": "<ISO UTC review timestamp>"
  }
}
```

6. Apply the reviewed JSON using the parameterized transaction below through an authorized database client. `$1` is the wallet address, `$2` the reviewed JSON, `$3` the EXACT exported original JSON. Require exactly one returned row; otherwise ROLLBACK, export again, re-review and retry. Do not overwrite concurrent changes. This is a manual, privileged action; no API accepts history approval from a wallet or agent.

```sql
BEGIN;
SELECT set_config('edith.payment_writer', '2', true);
UPDATE edith_users SET data = $2::jsonb, updated_at = now()
WHERE address = $1 AND data = $3::jsonb RETURNING address;
-- Operator checks exactly one row and verifies the reviewed diff before COMMIT; otherwise ROLLBACK.
```

7. Read back from a separate connection and verify both the ledger and `spentMist` through the signed-in API before enabling payments for that wallet. Retain the original export and evidence for review. Do not run a Mainnet payment as a smoke test. If any evidence is missing, leave `paymentHistory` absent and the wallet held. Waiting 24 hours may age out *known settled* spending; it cannot resolve lost outstanding signatures.

## 3. Recovery of an indefinitely uncertain signature

Use the existing **Check Sui again** action first. Success is counted as paid; a confirmed failed transaction releases the provider-price reservation (gas may have been charged).

For new signatures that are still NOT_FOUND, recheck also reads the first gas object's previous transaction. It releases only if a different transaction is checkpointed and its effects consume the exact gas object ID, version and digest bound to the original BCS transaction digest, with an address-owned input and a deletion or higher-version write. The persisted `invalidationProof` identifies the network, payment, consuming transaction, checkpoint and consumed gas reference. No transaction is signed or submitted by recovery.

If automatic discovery cannot find that exact consuming transaction (the coin was deleted or changed again), obtain it from an archival Sui source. The signed-in wallet can supply its digest to the same-origin endpoint `POST /api/requests/<id>/recheck` as `{"conflictingDigest":"<digest>"}`. This uses the normal authenticated session and origin checks. The server fetches and verifies effects itself; the client cannot supply an approval flag or trusted proof. The UI and wallet signing flow do not change.

For legacy records without saved BCS bytes, obtain the ORIGINAL unsigned transaction bytes from the wallet/provider's retained record; never request or persist a private key, seed phrase or signature. Verify the bytes' transaction digest and network against the reservation. An operator can attach `recovery: {network, transaction: "<base64 BCS>"}` to that exact item in both JSON collections using the reviewed, optimistic transaction procedure above, WITHOUT changing its state or history approval. Recheck independently revalidates the digest before using it. Missing original bytes means this invalidation path is unavailable; do not reconstruct bytes from guessed gas inputs.

If no checkpointed conflicting consumption exists, the signature might still execute. Retain the reservation; do not clear it for elapsed time, quote expiry, a provider refusal, an RPC error, missing objects, simulation rejection, or merely a higher current object version. Do not initiate a conflicting transaction as part of this runbook: it can cost gas or lock coins through equivocation. The owner would need a separately reviewed, explicitly authorized wallet action. This branch does not add transaction expiry or fabricate cancellation evidence. The reservation limits EDITH's future approvals; it does not itself lock wallet funds.

Evidence rules follow Sui's [transaction finality](https://docs.sui.io/develop/transactions/transaction-lifecycle) and [object model](https://docs.sui.io/develop/sui-architecture/object-model). Verification trusts the configured Tatum Sui gateway, as existing settlement does; it does not independently verify quorum signatures. The integration uses the pinned SDK's `getObject` and `getTransaction({include:{effects:true}})` fields. If a gateway omits required effects, the hold remains and an operator must resolve the evidence gap.

## Release sign-off

- Local full tests and build pass; no UI, dependency, wallet-signing or Vercel route changes.
- Staging verifies the Neon fence, transaction pooling, privileges, cold-start migration, old-writer rejection and read-only Sui effect retrieval on the correct network.
- Production writers are drained/retired and backups are retained.
- Every enabled legacy wallet has a reviewed complete ledger and evidence reference; all others remain held.
- No reservation was released without confirmed failure or the exact checkpointed consumption proof. Missing historical/legacy evidence remains an operational blocker, not an automatic waiver.
