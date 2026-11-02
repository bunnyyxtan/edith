import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { CHALLENGE_TTL_MS, signProof } from "../src/payment.mjs";
import { createLedger, createPaywall } from "../src/paywall.mjs";
import { createApp } from "../src/server.mjs";

const PAY_TO = `0x${"b".repeat(64)}`;
const RESOURCE = "/quote?ticker=SUI";
const DIGEST = "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd";
const DIGEST_2 = "GXTajvsC1XrEWDJ8ZRDUeGfxQihmEAqUvpgbYRDY3An5";

const ledgerPath = () => join(mkdtempSync(join(tmpdir(), "edith-")), "used.txt");

function setup({ payer = new Ed25519Keypair(), clock = { t: 1_000_000 }, chain = {}, ledger = createLedger(ledgerPath()) } = {}) {
  // Default chain: every digest is a confirmed 0.001 SUI payment from `payer`, made now.
  const lookups = [];
  const paywall = createPaywall({
    secret: "s",
    network: "mainnet",
    payTo: PAY_TO,
    price: 1_000_000n,
    ledger,
    now: () => clock.t,
    lookupPayment: async (digest, terms) => {
      lookups.push(digest);
      await new Promise((r) => setTimeout(r, 5));
      return { ok: terms.minAmount <= 1_000_000n, sender: payer.toSuiAddress(), timestampMs: clock.t, ...chain[digest] };
    },
  });
  const challengeFor = (resource = RESOURCE) => paywall.requirements(resource).accepts[0].extra.challenge;
  const proof = async (digest = DIGEST, { signer = payer, challenge = challengeFor() } = {}) =>
    JSON.stringify({ challenge, digest, signature: await signProof(signer, challenge, digest) });
  return { paywall, payer, clock, lookups, proof, challengeFor };
}

test("redeems a valid proof once", async () => {
  const { paywall, payer, proof } = setup();
  const header = await proof();
  assert.deepEqual(await paywall.redeem(RESOURCE, header), { payer: payer.toSuiAddress() });
  await assert.rejects(paywall.redeem(RESOURCE, header), /already used/);
});

test("concurrent redeems of the same digest: exactly one succeeds", async () => {
  const { paywall, proof } = setup();
  const headers = await Promise.all([proof(), proof(), proof()]);
  const results = await Promise.allSettled(headers.map((h) => paywall.redeem(RESOURCE, h)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("replay protection survives a restart", async () => {
  const path = ledgerPath();
  const first = setup({ ledger: createLedger(path) });
  await first.paywall.redeem(RESOURCE, await first.proof());
  const restarted = setup({ payer: first.payer, ledger: createLedger(path) });
  await assert.rejects(restarted.paywall.redeem(RESOURCE, await restarted.proof()), /already used/);
});

test("a digest stolen from the chain is useless without the payer's key", async () => {
  const { paywall, proof } = setup();
  const thief = new Ed25519Keypair();
  await assert.rejects(paywall.redeem(RESOURCE, await proof(DIGEST, { signer: thief })), /not signed by the payer/);
});

test("a challenge cannot be redeemed for a different resource", async () => {
  const { paywall, proof, challengeFor } = setup();
  const header = await proof(DIGEST, { challenge: challengeFor("/quote?ticker=ZZZ") });
  await assert.rejects(paywall.redeem(RESOURCE, header), /different request/);
});

test("expired challenges are rejected", async () => {
  const { paywall, proof, clock } = setup();
  const header = await proof();
  clock.t += CHALLENGE_TTL_MS + 1;
  await assert.rejects(paywall.redeem(RESOURCE, header), /expired/);
});

test("payments made before the challenge are rejected", async () => {
  const { paywall, proof, clock } = setup({ chain: { [DIGEST]: { timestampMs: 0 } } });
  clock.t = 10 * 60_000;
  await assert.rejects(paywall.redeem(RESOURCE, await proof()), /predates/);
});

test("underpaid, failed and unfinalized payments are rejected and the digest is released", async () => {
  const chain = { [DIGEST]: { ok: false }, [DIGEST_2]: { timestampMs: null } };
  const { paywall, proof } = setup({ chain });
  await assert.rejects(paywall.redeem(RESOURCE, await proof(DIGEST)), /below the required amount/);
  await assert.rejects(paywall.redeem(RESOURCE, await proof(DIGEST_2)), /not finalized/);
  chain[DIGEST_2] = {};
  assert.ok(await paywall.redeem(RESOURCE, await proof(DIGEST_2)), "released digest can be redeemed once it finalizes");
});

test("malformed headers fail before any chain lookup", async () => {
  const { paywall, lookups, challengeFor } = setup();
  await assert.rejects(paywall.redeem(RESOURCE, "not json"), /must be JSON/);
  await assert.rejects(paywall.redeem(RESOURCE, "x".repeat(5000)), /oversized/);
  await assert.rejects(paywall.redeem(RESOURCE, JSON.stringify({ challenge: challengeFor(), digest: "bad", signature: "x" })), /invalid transaction digest/);
  await assert.rejects(paywall.redeem(RESOURCE, JSON.stringify({ challenge: challengeFor(), digest: DIGEST, signature: "AAAA" })), /signature invalid/);
  assert.equal(lookups.length, 0);
});

const outage = () => ({ get ok() { throw Object.assign(new Error("Received HTTP status code 429"), { code: "UNAVAILABLE" }); } });

test("a verification outage releases the digest so the same proof can be retried", async () => {
  const chain = { [DIGEST]: outage() };
  const { paywall, payer, proof } = setup({ chain });
  const header = await proof();
  await assert.rejects(paywall.redeem(RESOURCE, header), /429/);
  chain[DIGEST] = {};
  assert.deepEqual(await paywall.redeem(RESOURCE, header), { payer: payer.toSuiAddress() });
});

test("HTTP: a verification outage answers 503 with Retry-After", async (t) => {
  const { paywall, proof } = setup({ chain: { [DIGEST]: outage() } });
  const server = createApp(paywall).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}${RESOURCE}`, { headers: { "x-payment": await proof() } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "2");
});

test("HTTP: 402 with terms, then data for a valid proof, then 402 on replay", async (t) => {
  const { paywall, proof } = setup();
  const server = createApp(paywall).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}${RESOURCE}`;

  const unpaid = await fetch(url);
  assert.equal(unpaid.status, 402);
  const challenge = (await unpaid.json()).accepts[0].extra.challenge;

  const header = await proof(DIGEST, { challenge });
  const paid = await fetch(url, { headers: { "x-payment": header } });
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).ticker, "SUI");

  const replay = await fetch(url, { headers: { "x-payment": header } });
  assert.equal(replay.status, 402);
  assert.match((await replay.json()).error, /already used/);
});
