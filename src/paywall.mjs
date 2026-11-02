// Server side of the payment protocol: issues 402 terms and redeems payment proofs exactly once.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PaymentError, SUI_COIN, isDigest, issueChallenge, proofSigner, readChallenge } from "./payment.mjs";

const MAX_HEADER_BYTES = 4096;
const CLOCK_SKEW_MS = 60_000;

// Digests are reserved synchronously before any await, so concurrent redeems of one digest cannot both pass.
// Committed digests are appended to disk and reloaded on start, so replay protection survives restarts.
export function createLedger(path) {
  const used = new Set(existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  const pending = new Set();
  return {
    reserve(digest) {
      if (used.has(digest) || pending.has(digest)) return false;
      pending.add(digest);
      return true;
    },
    commit(digest) {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${digest}\n`);
      pending.delete(digest);
      used.add(digest);
    },
    release(digest) {
      pending.delete(digest);
    },
  };
}

// lookupPayment(digest, { payTo, minAmount }) -> { ok, sender, timestampMs }
export function createPaywall({ secret, network, payTo, price, ledger, lookupPayment, now = Date.now }) {
  function requirements(resource) {
    const challenge = issueChallenge(secret, { resource, amount: String(price), payTo, network }, now());
    return {
      x402Version: 1,
      accepts: [{ scheme: "exact", network: `sui:${network}`, payTo, maxAmountRequired: String(price), asset: SUI_COIN, resource, extra: { challenge } }],
    };
  }

  async function redeem(resource, header) {
    if (!header || header.length > MAX_HEADER_BYTES) throw new PaymentError("missing or oversized X-PAYMENT header");
    let proof;
    try {
      proof = JSON.parse(header);
    } catch {
      throw new PaymentError("X-PAYMENT must be JSON {challenge, digest, signature}");
    }
    const { challenge, digest, signature } = proof;
    if (!isDigest(digest)) throw new PaymentError("invalid transaction digest");

    const claims = readChallenge(secret, challenge, now());
    if (claims.resource !== resource || claims.network !== network || claims.payTo !== payTo) {
      throw new PaymentError("challenge was issued for a different request");
    }
    const signer = await proofSigner(challenge, digest, signature);

    if (!ledger.reserve(digest)) throw new PaymentError("payment already used");
    try {
      const payment = await lookupPayment(digest, { payTo, minAmount: BigInt(claims.amount) });
      if (!payment.ok) throw new PaymentError("payment not found or below the required amount");
      if (payment.sender !== signer) throw new PaymentError("payment proof not signed by the payer");
      if (payment.timestampMs === null) throw new PaymentError("payment not finalized yet");
      if (payment.timestampMs < claims.iat - CLOCK_SKEW_MS) throw new PaymentError("payment predates the challenge");
      ledger.commit(digest);
      return { payer: signer };
    } catch (err) {
      ledger.release(digest);
      throw err;
    }
  }

  return { requirements, redeem };
}
