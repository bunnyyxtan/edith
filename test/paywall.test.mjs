import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { CHALLENGE_TTL_MS, paymentHeader } from "../src/payment.mjs";
import { createLedger, createPaywall } from "../src/paywall.mjs";
import { createApp } from "../src/server.mjs";
import { settlePayment } from "../src/sui.mjs";
import { fakeChain, signedTransfer } from "./chain.mjs";

const PAY_TO = `0x${"b".repeat(64)}`;
const PRICE = 1_000_000n;
const RESOURCE = "/quote?ticker=SUI";

const ledgerPath = () => join(mkdtempSync(join(tmpdir(), "edith-")), "used.txt");
const outage = () => Object.assign(new Error("Received HTTP status code 429"), { code: "UNAVAILABLE" });

function setup({ clock = { t: 1_000_000 }, ledger = createLedger(ledgerPath()) } = {}) {
  const chain = fakeChain({ now: () => clock.t });
  const settle = { calls: 0, fail: null };
  const paywall = createPaywall({
    secret: "s",
    network: "mainnet",
    payTo: PAY_TO,
    price: PRICE,
    ledger,
    now: () => clock.t,
    settlePayment: async (payment, terms) => {
      settle.calls++;
      if (settle.fail) throw settle.fail;
      return settlePayment(chain.client, payment, terms);
    },
  });
  const challengeFor = (resource = RESOURCE) => paywall.requirements(resource).accepts[0].extra.challenge;
  const transfer = async (overrides = {}) => {
    const t = await signedTransfer({ payTo: PAY_TO, amount: PRICE, ...overrides });
    chain.register(t);
    return t;
  };
  const header = (t, challenge = challengeFor()) => paymentHeader({ challenge, transaction: t.transaction, signature: t.signature });
  return { paywall, chain, clock, settle, transfer, header, challengeFor };
}

test("settles a signed transfer once", async () => {
  const { paywall, transfer, header } = setup();
  const t = await transfer();
  assert.deepEqual(await paywall.redeem(RESOURCE, header(t)), { payer: t.payer.toSuiAddress(), digest: t.digest });
  await assert.rejects(paywall.redeem(RESOURCE, header(t)), /already used/);
});

test("concurrent redeems of the same transfer: exactly one succeeds", async () => {
  const { paywall, transfer, header } = setup();
  const t = await transfer();
  const results = await Promise.allSettled([1, 2, 3].map(() => paywall.redeem(RESOURCE, header(t))));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});

test("replay protection survives a restart", async () => {
  const path = ledgerPath();
  const first = setup({ ledger: createLedger(path) });
  const t = await first.transfer();
  await first.paywall.redeem(RESOURCE, first.header(t));
  const restarted = setup({ ledger: createLedger(path) });
  restarted.chain.register(t);
  await assert.rejects(restarted.paywall.redeem(RESOURCE, restarted.header(t)), /already used/);
});

test("a transfer copied from the chain cannot buy a second answer with a fresh challenge", async () => {
  const { paywall, transfer, header, clock } = setup();
  const t = await transfer();
  await paywall.redeem(RESOURCE, header(t));
  clock.t += 10 * 60_000;
  await assert.rejects(paywall.redeem(RESOURCE, header(t)), /already used/);
});

test("a transfer that landed long before the challenge is rejected", async () => {
  const { paywall, chain, transfer, header, clock } = setup();
  const t = await transfer();
  chain.land(t.digest, 0);
  clock.t = 10 * 60_000;
  await assert.rejects(paywall.redeem(RESOURCE, header(t)), /predates/);
});

test("a challenge cannot be redeemed for a different resource", async () => {
  const { paywall, transfer, header, challengeFor } = setup();
  await assert.rejects(paywall.redeem(RESOURCE, header(await transfer(), challengeFor("/quote?ticker=ZZZ"))), /different request/);
});

test("expired challenges are rejected before anything is settled", async () => {
  const { paywall, transfer, header, clock, settle } = setup();
  const h = header(await transfer());
  clock.t += CHALLENGE_TTL_MS + 1;
  await assert.rejects(paywall.redeem(RESOURCE, h), /expired/);
  assert.equal(settle.calls, 0);
});

test("underpaid, failed and unfinalized transfers are rejected and the digest is released", async () => {
  const { paywall, chain, transfer, header } = setup();
  const cheap = await transfer({ amount: PRICE - 1n });
  await assert.rejects(paywall.redeem(RESOURCE, header(cheap)), /below the required amount/);
  const failed = await transfer();
  chain.overrides[failed.digest] = { success: false };
  await assert.rejects(paywall.redeem(RESOURCE, header(failed)), /below the required amount/);
  const pending = await transfer();
  chain.overrides[pending.digest] = { timestampMs: null };
  await assert.rejects(paywall.redeem(RESOURCE, header(pending)), /not finalized/);
  delete chain.overrides[pending.digest];
  assert.ok(await paywall.redeem(RESOURCE, header(pending)), "released digest can be redeemed once it finalizes");
});

test("a transfer Sui refuses is the payer's error, not an outage", async () => {
  const { paywall, chain, transfer, header } = setup();
  const t = await transfer();
  chain.overrides[t.digest] = { executeThrows: Object.assign(new Error("invalid signature"), { code: "INVALID_ARGUMENT" }) };
  await assert.rejects(paywall.redeem(RESOURCE, header(t)), /Sui rejected the payment transaction/);
});

test("malformed headers fail before anything is settled", async () => {
  const { paywall, settle, challengeFor } = setup();
  await assert.rejects(paywall.redeem(RESOURCE, "not json"), /must be JSON/);
  await assert.rejects(paywall.redeem(RESOURCE, "x".repeat(13_000)), /oversized/);
  await assert.rejects(paywall.redeem(RESOURCE, JSON.stringify({ challenge: challengeFor(), transaction: "AAAA", signature: "AAAA" })), /invalid signed transaction/);
  assert.equal(settle.calls, 0);
});

test("a settlement outage releases the digest so the same signed transfer can be retried", async () => {
  const { paywall, settle, transfer, header } = setup();
  const t = await transfer();
  const h = header(t);
  settle.fail = outage();
  await assert.rejects(paywall.redeem(RESOURCE, h), /429/);
  settle.fail = null;
  assert.equal((await paywall.redeem(RESOURCE, h)).digest, t.digest);
});

async function listen(t, paywall) {
  const server = createApp(paywall).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${server.address().port}`;
}

test("HTTP: a settlement outage answers 503 with Retry-After", async (t) => {
  const { paywall, settle, transfer, header } = setup();
  settle.fail = outage();
  const res = await fetch(`${await listen(t, paywall)}${RESOURCE}`, { headers: { "x-payment": header(await transfer()) } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "2");
});

test("HTTP: 402 with terms, then data for a signed transfer, then 402 on replay", async (t) => {
  const { paywall, transfer } = setup();
  const url = `${await listen(t, paywall)}${RESOURCE}`;

  const unpaid = await fetch(url);
  assert.equal(unpaid.status, 402);
  const challenge = (await unpaid.json()).accepts[0].extra.challenge;

  const signed = await transfer({ payer: new Ed25519Keypair() });
  const h = paymentHeader({ challenge, transaction: signed.transaction, signature: signed.signature });
  const paid = await fetch(url, { headers: { "x-payment": h } });
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).ticker, "SUI");

  const replay = await fetch(url, { headers: { "x-payment": h } });
  assert.equal(replay.status, 402);
  assert.match((await replay.json()).error, /already used/);
});
