// Payment protocol shared by the agent and the paywall.
//
// 1. The paywall answers 402 with terms and an HMAC-signed challenge that binds resource, amount,
//    payee and network, and expires.
// 2. The agent pays on Sui, then signs "challenge + digest" with the key that sent the payment.
// 3. The paywall checks the challenge, the signature, and that the signer is the transaction sender.
//    A digest observed on chain is useless to anyone who does not hold the payer's key.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

export const SUI_COIN = "0x2::sui::SUI";
export const CHALLENGE_TTL_MS = 5 * 60_000;
const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ADDRESS_RE = /^0x[0-9a-f]{64}$/;

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

const proofMessage = (challenge, digest) => new TextEncoder().encode(`edith-payment-proof:${challenge}:${digest}`);

export async function signProof(signer, challenge, digest) {
  const { signature } = await signer.signPersonalMessage(proofMessage(challenge, digest));
  return signature;
}

// Returns the Sui address that signed the proof; throws if the signature is invalid.
export async function proofSigner(challenge, digest, signature) {
  try {
    const publicKey = await verifyPersonalMessageSignature(proofMessage(challenge, digest), signature);
    return publicKey.toSuiAddress();
  } catch {
    throw new PaymentError("payment proof signature invalid");
  }
}

// Agent-side validation of a 402 body before any money moves.
export function parseTerms(body, network, maxAmount) {
  const terms = body?.accepts?.find((t) => t.scheme === "exact" && t.network === `sui:${network}`);
  if (!terms) throw new PaymentError(`no exact-scheme terms for sui:${network}`);
  if (terms.asset !== SUI_COIN) throw new PaymentError(`unsupported asset ${terms.asset}`);
  if (!ADDRESS_RE.test(terms.payTo ?? "")) throw new PaymentError("invalid payTo address");
  if (!/^[1-9]\d*$/.test(terms.maxAmountRequired ?? "")) throw new PaymentError("invalid amount");
  const amount = BigInt(terms.maxAmountRequired);
  if (amount > maxAmount) throw new PaymentError(`price ${amount} MIST exceeds cap ${maxAmount}`);
  if (typeof terms.extra?.challenge !== "string") throw new PaymentError("missing payment challenge");
  return { payTo: terms.payTo, amount, challenge: terms.extra.challenge };
}
