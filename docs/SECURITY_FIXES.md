# Payment security fixes

These changes address the four findings from the 3 November 2026 read-only audit. They do not establish why Slush flagged the site or remove a wallet reputation warning.

## Spending limits

Spending now lives in a separate `spending` collection in each wallet's existing JSON/Neon JSONB record. The existing per-wallet queue or Postgres row lock atomically checks the limit and reserves the amount. The 200-entry display history no longer controls accounting. Unresolved payments remain visible for the existing recheck action, alongside the recent history.

Confirmed payments count for 24 hours from the chain settlement time (falling back to reservation time for older records). Settling and uncertain signatures remain reserved regardless of age. Retained old records seed the ledger during an ordinary atomic update, but this does NOT certify that the history is complete. Existing accounts without an evidence-backed `paymentHistory` review cannot obtain new payable quotes or reserve payments. Free requests, sign-in and reconciliation remain available.

Postgres migration now installs `edith_wallet_writer_guard` on wallet inserts, updates and deletes. Only the guarded store sets the transaction-local writer version. Old Vercel instances and rollbacks cannot overwrite wallet JSON or create unaccounted payments. This is a compatibility fence, not authorization against a privileged database operator. It deliberately makes older wallet writers fail; follow the maintenance cutover in [PAYMENT_ROLLOUT.md](PAYMENT_ROLLOUT.md).

Subsequent cold starts inspect the installed trigger and function body under the migration lock and skip their DDL when they match. A disabled or altered fence fails startup for operator review instead of silently replacing a potentially newer guard.

## Signed payments

A provider's HTTP response is not evidence that its copy of a signature cannot execute. A missing transaction therefore stays uncertain even when the provider responds with an error. A confirmed Sui transaction failure releases the reservation as not paid; successful late settlement is reconciled through the existing UI. Gas may still be charged for a failed transaction.

New reservations also retain unsigned BCS transaction bytes and the network, never the signature. The existing recheck action can prove invalidation when a different checkpointed transaction consumed the exact first gas-object ID, version and digest from those bytes. It checks effects from the configured Sui gateway and retains the evidence in `invalidationProof`. A caller-supplied `conflictingDigest` is only a discovery hint, not trusted evidence. Missing/mismatched bytes, network mismatch, later object versions, missing effects and gateway errors keep the reservation. This is RPC-verified evidence under the same Tatum trust model as settlement, not independent light-client verification of checkpoint signatures.

The pinned `@mysten/sui` 2.38.0 Core contract uses `objectId`, a string-or-null `checkpoint`, and parsed `effects.changedObjects`. Offline integration fixtures pass protobuf JSON through the installed binary codecs and real `SuiGrpcClient` mapping, including failed transactions and missing fields. Core wraps missing transactions as `TransactionError(reason: "notFound")`, without a `code`; lookup retries and verification now handle that type so recovery remains reachable. Other RPC failures remain errors, never cancellation evidence.

Retained legacy `refused` payments with a digest are conservatively treated as uncertain unless an on-chain failure was recorded. Wallet signing and transaction construction are unchanged: the fix does not pretend that the off-chain quote deadline revokes a signature.

## Provider transport

External providers must use HTTPS. An explicit local development override permits loopback HTTP; the bundled demo retains its narrowly scoped configured loopback mapping. Public/production deployments reject `ALLOW_PRIVATE_PROVIDERS=1` before connecting to integrations.

HTTP(S) connections validate DNS inside the socket lookup and use exactly the checked addresses. Mixed public/private answers, private IP literals (including IPv4-mapped IPv6), and empty DNS answers are rejected. Connections retain the original Host/TLS identity and certificate verification, do not reuse sockets, and never follow redirects. Response-body timeouts and compressed JSON responses are supported without adding a dependency.

Each response is capped at 1 MiB on the wire AND 1 MiB after gzip, deflate or Brotli decompression, with a 16 KiB HTTP-header limit. Streaming counters enforce limits even without Content-Length; oversized advertised lengths are rejected immediately. A bounded buffer prevents tiny chunks from accumulating unbounded per-chunk objects. Overflow, corrupt compression and timeouts destroy the response pipeline. Unsupported/stacked encodings are rejected. Providers returning larger documents must reduce their payload; this limit is intentional. Rejection after signature handoff still checks Sui and retains uncertainty if payment cannot be confirmed.

## Verification and rollout considerations

Regression coverage includes file-store reload, Postgres JSONB persistence and concurrent reservations, activity eviction, late settlement, confirmed failures, legacy records, app/agent HTTP refusal, DNS rebinding, redirects, and response timeouts. Tests use local HTTP servers, fake Sui/Walrus clients, and in-process PGlite; they do not exercise live Neon or move funds. Run `npm test` and `npm run build` before reviewing a rollout.

- Payments already removed by the old history cap cannot be reconstructed from the remaining wallet record. Production historical reconciliation remains an operator action, with an enforced hold until completion. See the exact evidence and cutover requirements in [PAYMENT_ROLLOUT.md](PAYMENT_ROLLOUT.md). No production data was read or modified for this change.
- Unobserved signatures without verifiable invalidation evidence remain reserved indefinitely. Quote expiry is not on-chain expiration. Recovery of legacy records may require original unsigned transaction bytes and the exact consuming transaction; if these cannot be obtained, retain the hold.
- Drain old deployments before enabling payments. Keep the database fence installed, including on rollback. File storage has no database fence and must never be shared with a running old binary.
- Loopback demo exceptions are application configuration, not caller-controlled URLs. Keep the private-provider override disabled on hosted deployments.
- These accounting limits continue to cover provider prices, not network gas. Live Slush, Tatum, Walrus, and Neon validation requires a separately approved deployment/testing step.

No push or deployment is part of this change.
