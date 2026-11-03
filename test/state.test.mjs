// The Postgres state, run against PGlite (Postgres in-process): the payment-critical guarantees must hold
// when every request may land on a different function instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrate, pgLedger, pgLimiter, pgliteDb, pgNonces, pgPlans, pgStore } from "../src/state.mjs";
import { withActivity, spentToday } from "../src/store.mjs";

const ALICE = `0x${"a".repeat(64)}`;
const BOB = `0x${"b".repeat(64)}`;

async function setup() {
  const db = pgliteDb(new PGlite());
  await migrate(db);
  await migrate(db); // idempotent: every cold start runs it
  return db;
}

test("wallet records are isolated, and concurrent limit checks never overspend", async () => {
  const store = pgStore(await setup());
  assert.equal((await store.read(ALICE)).activity.length, 0);
  // Ten payments of 0.003 SUI race against a 0.02 SUI daily limit: only six may be counted.
  const tryPay = (i) => store.update(ALICE, (user) => {
    if (spentToday(user) + 3_000_000n > 20_000_000n) throw new Error("over limit");
    return withActivity(user, `p${i}`, { at: new Date().toISOString(), state: "settling", amountMist: "3000000" });
  });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => tryPay(i)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 6);
  assert.equal(spentToday(await store.read(ALICE)), 18_000_000n);
  assert.equal((await store.read(BOB)).activity.length, 0);
  await assert.rejects(store.read("../../etc/passwd"), /invalid address/);
});

test("a pending approval is claimed once, by its owner, before it expires", async () => {
  const clock = { t: 1_000_000 };
  const plans = pgPlans(await setup(), () => clock.t);
  const planned = { url: "https://p/q", context: { key: "k" }, terms: { payTo: BOB, amount: 1_000_000n, challenge: "c.m" } };
  await plans.put("id1", ALICE, planned, clock.t + 60_000);

  assert.deepEqual(await plans.take("id1", BOB), { reason: "missing" }, "another wallet cannot claim it");
  const claims = await Promise.all([plans.take("id1", ALICE), plans.take("id1", ALICE), plans.take("id1", ALICE)]);
  assert.equal(claims.filter((c) => c.planned).length, 1, "a double submit pays once");
  const won = claims.find((c) => c.planned).planned;
  assert.equal(won.terms.amount, 1_000_000n, "amounts survive storage as exact integers");
  assert.ok(claims.some((c) => c.reason === "busy"));
  assert.equal(await plans.cancel("id1", ALICE), false, "a quote being paid cannot be withdrawn");

  await plans.release("id1");
  assert.ok((await plans.take("id1", ALICE)).planned, "released after a failed check, it can be tried again");
  await plans.drop("id1");
  assert.deepEqual(await plans.take("id1", ALICE), { reason: "missing" });

  await plans.put("id2", ALICE, planned, clock.t + 60_000);
  clock.t += 61_000;
  assert.deepEqual(await plans.take("id2", ALICE), { reason: "expired" });
  await plans.put("id2", ALICE, planned, clock.t + 60_000);
  assert.ok((await plans.take("id2", ALICE)).planned, "a fresh price reopens it");
  await plans.put("id3", ALICE, planned, clock.t + 60_000);
  assert.equal(await plans.cancel("id3", ALICE), true);
  assert.deepEqual(await plans.take("id3", ALICE), { reason: "missing" });
});

test("the replay ledger reserves a digest once, commits it forever, and frees only failed attempts", async () => {
  const clock = { t: 1_000_000 };
  const ledger = pgLedger(await setup(), () => clock.t);
  const reserved = await Promise.all([1, 2, 3].map(() => ledger.reserve("D1")));
  assert.equal(reserved.filter(Boolean).length, 1, "concurrent redemptions: exactly one goes ahead");
  await ledger.release("D1");
  assert.equal(await ledger.reserve("D1"), true, "a failed attempt frees the digest");
  await ledger.commit("D1");
  await ledger.release("D1");
  assert.equal(await ledger.reserve("D1"), false, "a paid digest is never freed");
  clock.t += 60 * 60_000;
  assert.equal(await ledger.reserve("D1"), false, "not even much later");

  assert.equal(await ledger.reserve("D2"), true);
  assert.equal(await ledger.reserve("D2"), false);
  clock.t += 7 * 60_000;
  assert.equal(await ledger.reserve("D2"), true, "a reservation stranded by a crashed function can be retried");
});

test("sign-in nonces are spent once, and rate limits are shared", async () => {
  const db = await setup();
  const spend = pgNonces(db);
  const exp = Date.now() + 60_000;
  const spent = await Promise.all([spend("n1", exp), spend("n1", exp)]);
  assert.deepEqual(spent.sort(), [false, true]);
  const limit = pgLimiter(db, "test", { limit: 3, windowMs: 60_000 });
  const allowed = [];
  for (let i = 0; i < 5; i++) allowed.push(await limit("1.2.3.4"));
  assert.deepEqual(allowed, [true, true, true, false, false]);
  assert.equal(await limit("5.6.7.8"), true, "one key's limit does not affect another");
});

test("the paywall's double-redeem protection holds on the Postgres ledger", async () => {
  const { createPaywall } = await import("../src/paywall.mjs");
  const { paymentHeader } = await import("../src/payment.mjs");
  const { settlePayment } = await import("../src/sui.mjs");
  const { fakeChain, signedTransfer } = await import("./chain.mjs");
  const chain = fakeChain();
  const paywall = createPaywall({
    secret: "s", network: "mainnet", payTo: BOB, price: 1_000_000n, ledger: pgLedger(await setup()),
    settlePayment: (p, terms) => settlePayment(chain.client, p, terms),
  });
  const t = await signedTransfer({ payTo: BOB, amount: 1_000_000n });
  chain.register(t);
  const challenge = paywall.requirements("/quote?ticker=SUI").accepts[0].extra.challenge;
  const header = paymentHeader({ challenge, transaction: t.transaction, signature: t.signature });
  const results = await Promise.allSettled([1, 2, 3].map(() => paywall.redeem("/quote?ticker=SUI", header)));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  await assert.rejects(paywall.redeem("/quote?ticker=SUI", header), /already used/);
});
