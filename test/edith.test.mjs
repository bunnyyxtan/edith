// End-to-end over the real paywall and HTTP server, with a fake chain, real signed transfers and MemWalMock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { MemWalMock } from "@mysten-incubation/memwal";
import { createEdith, SettleError } from "../src/edith.mjs";
import { createLedger, createPaywall } from "../src/paywall.mjs";
import { createApp } from "../src/server.mjs";
import { settlePayment } from "../src/sui.mjs";
import { fakeChain, signedTransfer } from "./chain.mjs";

const PAY_TO = `0x${"d".repeat(64)}`;

async function listen(t, app) {
  const server = app.listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function setup(t) {
  const payer = new Ed25519Keypair();
  const chain = fakeChain();
  const paywall = createPaywall({
    secret: "s", network: "mainnet", payTo: PAY_TO, price: 1_000_000n,
    ledger: createLedger(join(mkdtempSync(join(tmpdir(), "edith-")), "used.txt")),
    settlePayment: (payment, terms) => settlePayment(chain.client, payment, terms),
  });
  const base = await listen(t, createApp(paywall));
  const memory = new MemWalMock({ namespace: "edith" });
  const edith = createEdith({ sui: chain.client, memory, network: "mainnet", payer: payer.toSuiAddress(), namespace: "edith-test" });
  // What the payer's wallet does when it approves a quote.
  const sign = async ({ terms }, overrides = {}) => {
    const t2 = await signedTransfer({ payer, payTo: terms.payTo, amount: terms.amount, ...overrides });
    chain.register(t2);
    return t2;
  };
  return { edith, chain, base, sign, payer };
}

const steps = () => {
  const seen = [];
  return { seen, emit: (e) => seen.push(e.step) };
};

test("a useful paid call is verified, remembered and stays payable", async (t) => {
  const { edith, base, sign } = await setup(t);
  const planned = await edith.plan(`${base}/quote?ticker=SUI`);
  assert.equal(planned.action, "pay");
  assert.equal(planned.terms.amount, 1_000_000n);

  const signed = await sign(planned);
  const log = steps();
  const settled = await edith.settle(planned, signed, log.emit);
  assert.equal(settled.result, "success");
  assert.equal(settled.digest, signed.digest);
  assert.equal(settled.body.ticker, "SUI");
  assert.ok(settled.blobId);
  assert.deepEqual(log.seen, ["checking", "paying", "verified", "judged", "remembered"]);
  assert.equal((await edith.plan(`${base}/quote?ticker=SUI`)).action, "pay");
});

test("junk after payment is remembered, and the next plan declines without contacting the provider", async (t) => {
  const { edith, chain, base, sign } = await setup(t);
  const planned = await edith.plan(`${base}/quote?ticker=ZZZ`);
  const settled = await edith.settle(planned, await sign(planned));
  assert.equal(settled.result, "failure");
  assert.equal(settled.problem.kind, "bad_payload");
  assert.equal(chain.calls.execute, 1);

  const log = steps();
  const again = await edith.plan(`${base}/quote?ticker=ZZZ`, {}, log.emit);
  assert.equal(again.action, "skip");
  assert.equal(again.decision.source, "memory");
  assert.match(again.decision.reason, /failed before/);
  assert.equal(again.decision.basis.digest, settled.digest, "the decline cites the paid failure");
  assert.deepEqual(log.seen, ["recalled"], "declined before asking the provider for a price");
  assert.equal(chain.calls.execute, 1, "no second payment");
});

test("the payer's limits stop a payment memory would allow", async (t) => {
  const { edith, base } = await setup(t);
  const perCall = await edith.plan(`${base}/quote?ticker=SUI`, { limits: { perCallMist: 999_999n, dailyMist: 10_000_000n } });
  assert.equal(perCall.action, "skip");
  assert.equal(perCall.decision.source, "limit");
  assert.match(perCall.decision.reason, /limit per payment/);

  const daily = await edith.plan(`${base}/quote?ticker=SUI`, { limits: { perCallMist: 5_000_000n, dailyMist: 2_000_000n }, spentMist: 1_500_000n });
  assert.equal(daily.action, "skip");
  assert.match(daily.decision.reason, /24 hours/);
});

test("a transfer that does not match the quote never leaves Edith", async (t) => {
  const { edith, chain, base, sign } = await setup(t);
  const planned = await edith.plan(`${base}/quote?ticker=SUI`);

  const wrongPayee = await sign({ terms: { ...planned.terms, payTo: `0x${"e".repeat(64)}` } });
  let err = await edith.settle(planned, wrongPayee).catch((e) => e);
  assert.ok(err instanceof SettleError);
  assert.equal(err.stage, "check");
  assert.match(err.message, /someone other than the quoted provider/);

  const wrongAmount = await sign(planned, { amount: 2_000_000n });
  err = await edith.settle(planned, wrongAmount).catch((e) => e);
  assert.match(err.message, /not the quoted/);

  const otherSender = await sign(planned, { payer: new Ed25519Keypair() });
  err = await edith.settle(planned, otherSender).catch((e) => e);
  assert.match(err.message, /different account/);

  assert.equal(chain.calls.execute, 0, "nothing was submitted");
});

test("a provider that refuses the payment leaves nothing paid", async (t) => {
  const { edith, chain, base, sign } = await setup(t);
  const planned = await edith.plan(`${base}/quote?ticker=SUI`);
  const signed = await sign(planned);
  chain.overrides[signed.digest] = { executeThrows: Object.assign(new Error("bad sig"), { code: "INVALID_ARGUMENT" }) };
  const err = await edith.settle(planned, signed).catch((e) => e);
  assert.equal(err.stage, "refused");
  assert.equal(err.paid, false);
});

test("an unreachable provider is uncertain until Sui says otherwise, then reconciled", async (t) => {
  const { edith, chain, base, sign } = await setup(t);
  const planned = await edith.plan(`${base}/quote?ticker=SUI`);
  const signed = await sign(planned);
  const dead = { ...planned, url: "http://127.0.0.1:1/quote?ticker=SUI" };
  const err = await edith.settle(dead, signed).catch((e) => e);
  assert.equal(err.stage, "uncertain");
  assert.equal(err.digest, signed.digest);

  assert.equal((await edith.reconcile({ ...planned, digest: signed.digest })).paid, false);
  chain.land(signed.digest);
  const later = await edith.reconcile({ ...planned, digest: signed.digest });
  assert.equal(later.paid, true);
  assert.equal(later.problem.kind, "transient");
  assert.ok(later.blobId);
});

test("terms over the hard ceiling are refused before any payment", async (t) => {
  const { edith } = await setup(t);
  const greedy = createApp({ requirements: () => ({ accepts: [{ scheme: "exact", network: "sui:mainnet", payTo: PAY_TO, maxAmountRequired: "90000000", asset: "0x2::sui::SUI", extra: { challenge: "c.m" } }] }), redeem: async () => {} });
  const base = await listen(t, greedy);
  await assert.rejects(edith.plan(`${base}/quote?ticker=SUI`), /exceeds cap/);
});
