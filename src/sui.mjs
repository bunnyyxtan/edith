// Sui access through Tatum's gRPC gateway: settling signed payments, checking them before they are
// sent, and verifying them afterwards.
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { TransactionError } from "@mysten/sui/client";
import { PaymentError, isSuiCoin, transactionDigest } from "./payment.mjs";

export const NETWORK = process.env.SUI_NETWORK ?? "devnet";

export function tatumSuiClient(network = NETWORK, apiKey = process.env.TATUM_API_KEY) {
  // Tatum serves native gRPC (application/grpc); the SDK default is gRPC-web, so swap the transport.
  const transport = new GrpcTransport({
    host: `sui-${network}-grpc.gateway.tatum.io:443`,
    channelCredentials: ChannelCredentials.createSsl(),
    meta: apiKey ? { "x-api-key": apiKey } : {},
  });
  return new SuiGrpcClient({ network, transport });
}

// Addresses compared in one canonical form, so 0x2 and 0x000…02 are the same account.
const sameAddress = (a, b) => Boolean(a && b) && normalizeSuiAddress(a) === normalizeSuiAddress(b);

// Rate limits, gateway hiccups and indexing lag right after execution are worth a short retry.
const RETRYABLE_CODES = new Set(["UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED", "NOT_FOUND"]);

// Submitting is different: NOT_FOUND there means a missing gas coin, which no retry fixes.
const OUTAGE_CODES = new Set(["UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED"]);
// @mysten/sui 2.38 Core wraps gRPC NOT_FOUND; its TransactionError has no `code`.
const transactionNotFound = (err) => err instanceof TransactionError && err.reason === "notFound";

export async function withRetry(fn, { attempts = 4, baseDelayMs = 500, codes = RETRYABLE_CODES } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !codes.has(transactionNotFound(err) ? "NOT_FOUND" : err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

// ok only if the tx succeeded and payTo received at least minAmount of coinType.
// NOT_FOUND is an unresolved signature, never proof that it cannot execute later.
export async function verifyPayment(client, digest, { payTo, minAmount }) {
  let res;
  try {
    res = await withRetry(() => client.core.getTransaction({ digest, include: { balanceChanges: true, transaction: true } }));
  } catch (err) {
    if (err.code === "NOT_FOUND" || transactionNotFound(err)) return { ok: false, status: "not_found", received: 0n, sender: null, timestampMs: null };
    throw err;
  }
  const tx = res.Transaction ?? res.FailedTransaction;
  const received = tx.balanceChanges
    .filter((c) => sameAddress(c.address, payTo) && isSuiCoin(c.coinType))
    .reduce((sum, c) => sum + BigInt(c.amount), 0n);
  return {
    ok: tx.status.success && received >= BigInt(minAmount),
    status: tx.status.success ? "success" : "failed",
    received,
    sender: tx.transaction.sender,
    timestampMs: tx.timestampMs,
  };
}

// Read-only recovery. A different checkpointed transaction must have consumed the exact gas
// reference in the original BCS bytes. A newer current object alone is NOT proof: our payment
// itself might have produced it. Missing bytes, missing effects and RPC errors retain the hold.
// conflictingDigest is only a discovery hint; all evidence is fetched from our Sui client.
export async function provePaymentInvalidated(client, { digest, recovery, network }, conflictingDigest) {
  if (!recovery?.transaction || recovery.network !== network) return null;
  try {
    const bytes = fromBase64(recovery.transaction);
    if (transactionDigest(bytes) !== digest) return null;
    const gas = TransactionDataBuilder.fromBytes(bytes).gasData.payment?.[0];
    if (!gas) return null;
    let candidate = conflictingDigest;
    if (!candidate) {
      const { object } = await client.core.getObject({ objectId: gas.objectId, include: { previousTransaction: true } });
      if (!sameAddress(object.objectId, gas.objectId)) return null;
      candidate = object.previousTransaction;
    }
    if (!candidate || candidate === digest) return null;
    const res = await client.core.getTransaction({ digest: candidate, include: { effects: true } });
    const tx = res.Transaction ?? res.FailedTransaction;
    // Pinned Core types use objectId (not id), string | null checkpoints, and parsed effects.
    if (tx?.digest !== candidate || typeof tx.checkpoint !== "string" || !/^\d+$/.test(tx.checkpoint) ||
      tx.effects?.transactionDigest !== candidate || !Array.isArray(tx.effects.changedObjects)) return null;
    const consumed = tx.effects.changedObjects.find((change) =>
      sameAddress(change.objectId, gas.objectId) && change.inputState === "Exists" &&
      change.inputVersion === gas.version && change.inputDigest === gas.digest &&
      change.inputOwner?.$kind === "AddressOwner" &&
      (change.outputState === "DoesNotExist" || (change.outputState === "ObjectWrite" &&
        /^\d+$/.test(change.outputVersion ?? "") && BigInt(change.outputVersion) > BigInt(gas.version))));
    if (!consumed) return null;
    return { kind: "gas-input-consumed", network, paymentDigest: digest, conflictingDigest: candidate,
      checkpoint: tx.checkpoint, gas: { objectId: gas.objectId, version: gas.version, digest: gas.digest } };
  } catch {
    return null;
  }
}

// Provider side: submit the payer's signed transfer, wait for it to land, then read what payTo received.
// Submitting a transaction that already landed returns its effects, so retrying after an outage is safe.
// Sui refusing the transaction (bad signature, no gas) is the payer's problem: a PaymentError, not an outage.
export async function settlePayment(client, { bytes, signature, digest }, terms) {
  try {
    await withRetry(() => client.core.executeTransaction({ transaction: bytes, signatures: [signature] }), { codes: OUTAGE_CODES });
  } catch (err) {
    if (OUTAGE_CODES.has(err.code)) throw err;
    throw new PaymentError(`Sui rejected the payment transaction: ${err.message}`);
  }
  await withRetry(() => client.core.waitForTransaction({ digest, timeout: 30_000 }));
  return verifyPayment(client, digest, terms);
}

// Payer side, before a signed transfer leaves Edith: simulate it and confirm it pays exactly the quote,
// from this sender, to this payee and nobody else. Returns a reason string when it does not.
export async function checkTransfer(client, bytes, { sender, payTo, amount }) {
  let res;
  try {
    res = await withRetry(() => client.core.simulateTransaction({ transaction: bytes, include: { balanceChanges: true, transaction: true } }), { codes: OUTAGE_CODES });
  } catch (err) {
    // Sui refusing the inputs (a gas coin already spent, an empty wallet) is an answer, not an outage.
    if (OUTAGE_CODES.has(err.code)) throw err;
    const why = /could not find the referenced object/i.test(err.message) ? "the coin it pays with is gone or already spent" : err.message.replace(/^Error checking transaction input objects: /, "");
    return `Sui would refuse it: ${why}. Check your wallet's balance and try again`;
  }
  const tx = res.Transaction ?? res.FailedTransaction;
  if (!tx.status.success) return `the transfer would fail on Sui (${tx.status.error?.message ?? "execution error"})`;
  if (!sameAddress(tx.transaction.sender, sender)) return "the transfer was signed by a different account than the one signed in";
  const credits = tx.balanceChanges.filter((c) => BigInt(c.amount) > 0n && !sameAddress(c.address, sender));
  const paid = credits.filter((c) => sameAddress(c.address, payTo) && isSuiCoin(c.coinType)).reduce((sum, c) => sum + BigInt(c.amount), 0n);
  if (credits.some((c) => !sameAddress(c.address, payTo))) return "the transfer pays someone other than the quoted provider";
  if (credits.some((c) => !isSuiCoin(c.coinType))) return "the transfer moves a coin other than SUI";
  if (paid !== BigInt(amount)) return `the transfer pays ${paid} MIST, not the quoted ${amount} MIST`;
  return null;
}

export function explorerUrl(digest, network = NETWORK) {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
