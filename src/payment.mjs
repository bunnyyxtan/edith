// Payment protocol shared by the payer and the paywall (the x402 "exact" shape on Sui).
//
// 1. The paywall answers 402 with terms and an HMAC-signed challenge that binds resource, amount,
//    payee and network, and expires.
// 2. The payer signs a SUI transfer for those terms but does not submit it. Its wallet holds the key.
// 3. The paywall checks the challenge, submits the signed transfer itself, confirms the credit, and
//    answers in the same exchange. The transaction is off chain until the provider settles it, so
//    nobody else can see it, let alone redeem it.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeStructTag } from "@mysten/sui/utils";

export const SUI_COIN = "0x2::sui::SUI";
const SUI_COIN_TAG = normalizeStructTag(SUI_COIN); // 0x000…0002::sui::SUI

// True only for the native coin: package 0x2, module sui, type SUI, no type parameters, after normalizing
// the address. A coin from any other package named ::sui::SUI is not SUI.
export function isSuiCoin(type) {
  try {
    return normalizeStructTag(String(type)) === SUI_COIN_TAG;
  } catch {
    return false;
  }
}
export const CHALLENGE_TTL_MS = 5 * 60_000;
const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export class PaymentError extends Error {}

const mac = (secret, payload) => createHmac("sha256", secret).update(payload).digest("base64url");

export function issueChallenge(secret, terms, now = Date.now()) {
  const claims = { ...terms, iat: now, exp: now + CHALLENGE_TTL_MS, nonce: randomBytes(12).toString("base64url") };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

export function readChallenge(secret, challenge, now = Date.now()) {
  const parts = String(challenge).split(".");
  if (parts.length !== 2) throw new PaymentError("malformed challenge");
  const [payload, signature] = parts;
  const expected = Buffer.from(mac(secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new PaymentError("challenge signature invalid");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (now > claims.exp) throw new PaymentError("challenge expired");
  return claims;
}

export function isDigest(value) {
  return typeof value === "string" && DIGEST_RE.test(value);
}

// The digest a signed transaction will have on chain, known before anyone submits it.
export function transactionDigest(bytes) {
  return TransactionDataBuilder.getDigestFromBytes(bytes);
}

// X-PAYMENT header: the challenge it answers and the payer's signed, unsubmitted transfer (base64 BCS).
export const paymentHeader = ({ challenge, transaction, signature }) => JSON.stringify({ challenge, transaction, signature });

export function readPaymentHeader(header) {
  let proof;
  try {
    proof = JSON.parse(header);
  } catch {
    throw new PaymentError("X-PAYMENT must be JSON {challenge, transaction, signature}");
  }
  const { challenge, transaction, signature } = proof ?? {};
  if (typeof challenge !== "string") throw new PaymentError("missing payment challenge");
  if (typeof transaction !== "string" || !BASE64_RE.test(transaction)) throw new PaymentError("invalid signed transaction");
  if (typeof signature !== "string" || !BASE64_RE.test(signature)) throw new PaymentError("invalid transaction signature");
  const bytes = fromBase64(transaction);
  let digest;
  try {
    TransactionDataBuilder.fromBytes(bytes); // parses, so garbage never reaches the chain or the ledger
    digest = transactionDigest(bytes);
  } catch {
    throw new PaymentError("invalid signed transaction");
  }
  return { challenge, bytes, signature, digest };
}

// Agent-side validation of a 402 body before any money moves.
export function parseTerms(body, network, maxAmount) {
  const terms = body?.accepts?.find((t) => t.scheme === "exact" && t.network === `sui:${network}`);
  if (!terms) throw new PaymentError(`no exact-scheme terms for sui:${network}`);
  if (!isSuiCoin(terms.asset)) throw new PaymentError(`unsupported asset ${terms.asset}`);
  if (!ADDRESS_RE.test(terms.payTo ?? "")) throw new PaymentError("invalid payTo address");
  if (!/^[1-9]\d*$/.test(terms.maxAmountRequired ?? "")) throw new PaymentError("invalid amount");
  const amount = BigInt(terms.maxAmountRequired);
  if (amount > maxAmount) throw new PaymentError(`price ${amount} MIST exceeds cap ${maxAmount}`);
  if (typeof terms.extra?.challenge !== "string") throw new PaymentError("missing payment challenge");
  return { payTo: terms.payTo, amount, challenge: terms.extra.challenge };
}
