import { test } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { CHALLENGE_TTL_MS, PaymentError, SUI_COIN, issueChallenge, parseTerms, proofSigner, readChallenge, signProof } from "../src/payment.mjs";

const SECRET = "test-secret";
const TERMS = { resource: "/quote?ticker=SUI", amount: "1000000", payTo: `0x${"a".repeat(64)}`, network: "mainnet" };
const DIGEST = "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd";

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

test("payment proof identifies the signing address", async () => {
  const payer = new Ed25519Keypair();
  const challenge = issueChallenge(SECRET, TERMS);
  const signature = await signProof(payer, challenge, DIGEST);
  assert.equal(await proofSigner(challenge, DIGEST, signature), payer.toSuiAddress());
});

test("a proof signed for one digest does not validate for another", async () => {
  const payer = new Ed25519Keypair();
  const challenge = issueChallenge(SECRET, TERMS);
  const signature = await signProof(payer, challenge, DIGEST);
  const other = "GXTajvsC1XrEWDJ8ZRDUeGfxQihmEAqUvpgbYRDY3An5";
  await assert.rejects(proofSigner(challenge, other, signature), PaymentError);
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
