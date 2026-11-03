import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGE_TTL_MS, PaymentError, SUI_COIN, issueChallenge, parseTerms, paymentHeader, readChallenge, readPaymentHeader } from "../src/payment.mjs";
import { signedTransfer } from "./chain.mjs";

const SECRET = "test-secret";
const TERMS = { resource: "/quote?ticker=SUI", amount: "1000000", payTo: `0x${"a".repeat(64)}`, network: "mainnet" };

test("challenge round-trips and carries its terms", () => {
  const claims = readChallenge(SECRET, issueChallenge(SECRET, TERMS, 1000), 1000);
  assert.equal(claims.resource, TERMS.resource);
  assert.equal(claims.exp, 1000 + CHALLENGE_TTL_MS);
});

test("challenge rejects tampering, a wrong secret and expiry", () => {
  const challenge = issueChallenge(SECRET, TERMS, 1000);
  const [payload, mac] = challenge.split(".");
  const forged = Buffer.from(JSON.stringify({ ...TERMS, amount: "1" })).toString("base64url");
  assert.throws(() => readChallenge(SECRET, `${forged}.${mac}`, 1000), /signature invalid/);
  assert.throws(() => readChallenge("other-secret", challenge, 1000), /signature invalid/);
  assert.throws(() => readChallenge(SECRET, `${payload}`, 1000), /malformed/);
  assert.throws(() => readChallenge(SECRET, challenge, 1000 + CHALLENGE_TTL_MS + 1), /expired/);
});

test("payment header carries the signed transfer and its on-chain digest", async () => {
  const signed = await signedTransfer({ payTo: TERMS.payTo, amount: 1_000_000n });
  const read = readPaymentHeader(paymentHeader({ challenge: "c.m", transaction: signed.transaction, signature: signed.signature }));
  assert.equal(read.challenge, "c.m");
  assert.equal(read.digest, signed.digest);
  assert.equal(read.signature, signed.signature);
  assert.deepEqual([...read.bytes], [...signed.bytes]);
});

test("payment header rejects anything that is not a signed transfer", () => {
  assert.throws(() => readPaymentHeader("not json"), /must be JSON/);
  assert.throws(() => readPaymentHeader(JSON.stringify({ transaction: "AAAA", signature: "AAAA" })), /missing payment challenge/);
  assert.throws(() => readPaymentHeader(JSON.stringify({ challenge: "c", transaction: "not base64!", signature: "AAAA" })), /invalid signed transaction/);
  assert.throws(() => readPaymentHeader(JSON.stringify({ challenge: "c", transaction: "AAAA", signature: 5 })), /invalid transaction signature/);
  assert.throws(() => readPaymentHeader(JSON.stringify({ challenge: "c", transaction: "AAAA", signature: "AAAA" })), PaymentError);
});

const body = (overrides = {}) => ({
  accepts: [{ scheme: "exact", network: "sui:mainnet", payTo: TERMS.payTo, maxAmountRequired: "1000000", asset: SUI_COIN, extra: { challenge: "c.m" }, ...overrides }],
});

test("parseTerms accepts well-formed terms", () => {
  assert.deepEqual(parseTerms(body(), "mainnet", 5_000_000n), { payTo: TERMS.payTo, amount: 1_000_000n, challenge: "c.m" });
});

test("parseTerms refuses unsafe terms before any payment", () => {
  const cap = 5_000_000n;
  assert.throws(() => parseTerms(body(), "testnet", cap), /no exact-scheme terms/);
  assert.throws(() => parseTerms(body({ asset: "0x1::fake::COIN" }), "mainnet", cap), /unsupported asset/);
  assert.throws(() => parseTerms(body({ payTo: "0x123" }), "mainnet", cap), /payTo/);
  assert.throws(() => parseTerms(body({ maxAmountRequired: "-5" }), "mainnet", cap), /invalid amount/);
  assert.throws(() => parseTerms(body({ maxAmountRequired: "5000001" }), "mainnet", cap), /exceeds cap/);
  assert.throws(() => parseTerms(body({ extra: {} }), "mainnet", cap), /challenge/);
});

test("isSuiCoin accepts every spelling of native SUI and nothing else", async () => {
  const { isSuiCoin } = await import("../src/payment.mjs");
  assert.equal(isSuiCoin("0x2::sui::SUI"), true);
  assert.equal(isSuiCoin("0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"), true);
  for (const type of ["0xabcde::sui::SUI", "0x2::sui::sui", "0x2::coin::SUI", "0x2::sui::SUI<u8>", "::sui::SUI", "", null, "not a type"]) {
    assert.equal(isSuiCoin(type), false, String(type));
  }
  assert.throws(() => parseTerms(body({ asset: "0xabcde::sui::SUI" }), "mainnet", 5_000_000n), /unsupported asset/);
  assert.equal(parseTerms(body({ asset: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" }), "mainnet", 5_000_000n).amount, 1_000_000n);
});
