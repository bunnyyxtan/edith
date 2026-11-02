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
  assert.deepEqual(result, { ok: true, received: 1000n, sender: "0xpayer", timestampMs: 123 });
  assert.equal((await verifyPayment(client, "d", { payTo: PAY_TO, minAmount: 1001n })).ok, false);
});

test("verifyPayment rejects failed transactions", async () => {
  const client = clientReturning(async () => tx([{ address: PAY_TO, coinType: "0x2::sui::SUI", amount: "1000" }], false));
  assert.equal((await verifyPayment(client, "d", { payTo: PAY_TO, minAmount: 1n })).ok, false);
});
