// Sui access through Tatum's gRPC gateway, plus payment lookup.
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";
import { SUI_COIN } from "./payment.mjs";

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

const coinSuffix = (type) => type.slice(type.indexOf("::"));

// Rate limits, gateway hiccups and indexing lag right after execution are worth a short retry.
const RETRYABLE_CODES = new Set(["UNAVAILABLE", "RESOURCE_EXHAUSTED", "DEADLINE_EXCEEDED", "NOT_FOUND"]);

export async function withRetry(fn, { attempts = 4, baseDelayMs = 500 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !RETRYABLE_CODES.has(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

// ok only if the tx succeeded and payTo received at least minAmount of coinType.
// A digest the chain still does not know after retries is reported as not paid, not as an outage.
export async function verifyPayment(client, digest, { payTo, minAmount }) {
  let res;
  try {
    res = await withRetry(() => client.core.getTransaction({ digest, include: { balanceChanges: true, transaction: true } }));
  } catch (err) {
    if (err.code === "NOT_FOUND") return { ok: false, received: 0n, sender: null, timestampMs: null };
    throw err;
  }
  const tx = res.Transaction ?? res.FailedTransaction;
  const received = tx.balanceChanges
    .filter((c) => c.address === payTo && coinSuffix(c.coinType) === coinSuffix(SUI_COIN))
    .reduce((sum, c) => sum + BigInt(c.amount), 0n);
  return {
    ok: tx.status.success && received >= BigInt(minAmount),
    received,
    sender: tx.transaction.sender,
    timestampMs: tx.timestampMs,
  };
}

export function explorerUrl(digest, network = NETWORK) {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
