import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPayment, withRetry } from "../src/sui.mjs";

const rpcError = (code) => Object.assign(new Error(code), { code });
const PAY_TO = `0x${"c".repeat(64)}`;
const FAST = { attempts: 3, baseDelayMs: 1 };

test("withRetry retries transient gateway errors, then succeeds", async () => {
  let calls = 0;
  const result = await withRetry(async () => (++calls < 3 ? Promise.reject(rpcError("RESOURCE_EXHAUSTED")) : "ok"), FAST);
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry gives up after the last attempt and does not retry other errors", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw rpcError("UNAVAILABLE"); }, FAST), /UNAVAILABLE/);
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw rpcError("INVALID_ARGUMENT"); }, FAST), /INVALID_ARGUMENT/);
  assert.equal(calls, 1);
});

const clientReturning = (getTransaction) => ({ core: { getTransaction } });
const tx = (changes, success = true) => ({
  Transaction: { status: { success }, balanceChanges: changes, transaction: { sender: "0xpayer" }, timestampMs: 123 },
});

test("verifyPayment sums SUI credited to the payee", async () => {
  const client = clientReturning(async () => tx([
    { address: PAY_TO, coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", amount: "600" },
    { address: PAY_TO, coinType: "0x2::sui::SUI", amount: "400" },
    { address: PAY_TO, coinType: "0xabc::fake::COIN", amount: "999999" },
    { address: "0xother", coinType: "0x2::sui::SUI", amount: "999999" },
  ]));
  const result = await verifyPayment(client, "d", { payTo: PAY_TO, minAmount: 1000n });
  assert.deepEqual(result, { ok: true, status: "success", received: 1000n, sender: "0xpayer", timestampMs: 123 });
  assert.equal((await verifyPayment(client, "d", { payTo: PAY_TO, minAmount: 1001n })).ok, false);
});

test("verifyPayment rejects failed transactions", async () => {
  const client = clientReturning(async () => tx([{ address: PAY_TO, coinType: "0x2::sui::SUI", amount: "1000" }], false));
  const result = await verifyPayment(client, "d", { payTo: PAY_TO, minAmount: 1n });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
});

test("a digest not found on chain stays distinguishable from a finalized failure", async () => {
  const result = await verifyPayment(clientReturning(async () => { throw rpcError("NOT_FOUND"); }), "d", { payTo: PAY_TO, minAmount: 1n });
  assert.equal(result.ok, false);
  assert.equal(result.status, "not_found");
});

test("checkTransfer reports a transfer Sui refuses, and lets outages through", async () => {
  const { checkTransfer } = await import("../src/sui.mjs");
  const refusing = { core: { simulateTransaction: async () => { throw Object.assign(new Error("Error checking transaction input objects: Could not find the referenced object 0x11"), { code: "INVALID_ARGUMENT" }); } } };
  assert.match(await checkTransfer(refusing, new Uint8Array(), { sender: "0xa", payTo: "0xb", amount: 1n }), /Sui would refuse it: the coin it pays with is gone or already spent/);
  let calls = 0;
  const down = { core: { simulateTransaction: async () => { calls++; throw Object.assign(new Error("unavailable"), { code: "UNAVAILABLE" }); } } };
  await assert.rejects(checkTransfer(down, new Uint8Array(), { sender: "0xa", payTo: "0xb", amount: 1n }), /unavailable/);
  assert.equal(calls, 4, "outages are retried before giving up");
});

test("only native SUI counts: a look-alike ::sui::SUI coin from another package is not paid", async () => {
  const fake = "0x00000000000000000000000000000000000000000000000000000000000abcde::sui::SUI";
  const client = clientReturning(async () => tx([{ address: PAY_TO, coinType: fake, amount: "5000000" }]));
  const result = await verifyPayment(client, "d", { payTo: PAY_TO, minAmount: 1n });
  assert.equal(result.ok, false);
  assert.equal(result.received, 0n);
});

test("checkTransfer refuses a transfer of a look-alike coin before it is sent", async () => {
  const { checkTransfer } = await import("../src/sui.mjs");
  const sender = `0x${"a".repeat(64)}`;
  const simulate = (coinType) => ({ core: { simulateTransaction: async () => ({ Transaction: {
    status: { success: true }, transaction: { sender },
    balanceChanges: [{ address: sender, coinType: "0x2::sui::SUI", amount: "-1000" }, { address: PAY_TO, coinType, amount: "1000" }],
  } }) } });
  const terms = { sender, payTo: PAY_TO, amount: 1000n };
  assert.equal(await checkTransfer(simulate("0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"), new Uint8Array(), terms), null);
  assert.match(await checkTransfer(simulate("0xabcde::sui::SUI"), new Uint8Array(), terms), /coin other than SUI/);
  assert.match(await checkTransfer(simulate("0x2::sui::SUI"), new Uint8Array(), { ...terms, sender: `0x${"b".repeat(64)}` }), /different account/);
});
