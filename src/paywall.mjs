// Server side of the payment protocol: issues 402 terms, settles the payer's signed transfer and
// answers each payment exactly once.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { PaymentError, SUI_COIN, issueChallenge, readChallenge, readPaymentHeader } from "./payment.mjs";

const MAX_HEADER_BYTES = 12_288; // zkLogin and passkey signatures run to a few KB
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

// settlePayment({ bytes, signature, digest }, { payTo, minAmount }) -> { ok, sender, timestampMs }
// Submits the signed transfer (a no-op if it already landed) and reports what reached payTo.
export function createPaywall({ secret, network, payTo, price, ledger, settlePayment, now = Date.now }) {
  function requirements(resource) {
    const challenge = issueChallenge(secret, { resource, amount: String(price), payTo, network }, now());
    return {
      x402Version: 1,
      accepts: [{ scheme: "exact", network: `sui:${network}`, payTo, maxAmountRequired: String(price), asset: SUI_COIN, resource, extra: { challenge } }],
    };
  }

  async function redeem(resource, header) {
    if (!header || header.length > MAX_HEADER_BYTES) throw new PaymentError("missing or oversized X-PAYMENT header");
    const { challenge, bytes, signature, digest } = readPaymentHeader(header);

    const claims = readChallenge(secret, challenge, now());
    if (claims.resource !== resource || claims.network !== network || claims.payTo !== payTo) {
      throw new PaymentError("challenge was issued for a different request");
    }

    if (!(await ledger.reserve(digest))) throw new PaymentError("payment already used");
    let payment;
    try {
      payment = await settlePayment({ bytes, signature, digest }, { payTo, minAmount: BigInt(claims.amount) });
      if (!payment.ok) throw new PaymentError("payment not found or below the required amount");
      if (payment.timestampMs === null) throw new PaymentError("payment not finalized yet");
      // A transfer that landed before this challenge was issued is an old payment being replayed.
      if (payment.timestampMs < claims.iat - CLOCK_SKEW_MS) throw new PaymentError("payment predates the challenge");
    } catch (err) {
      await ledger.release(digest);
      throw err;
    }
    // Paid: never released from here on. If recording fails, the reservation stays and blocks reuse.
    await ledger.commit(digest);
    return { payer: payment.sender, digest };
  }

  return { requirements, redeem };
}
