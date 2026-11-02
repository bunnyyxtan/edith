// Sui access through Tatum's gRPC gateway, plus payment verification.
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import { ChannelCredentials } from "@grpc/grpc-js";

export const SUI = "0x2::sui::SUI";
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

// ok only if the tx succeeded and payTo received at least minAmount of coinType.
export async function verifyPayment(client, digest, { payTo, minAmount, coinType = SUI }) {
  const res = await client.core.getTransaction({ digest, include: { balanceChanges: true } });
  const tx = res.Transaction ?? res.FailedTransaction;
  const received = tx.balanceChanges
    .filter((c) => c.address === payTo && coinSuffix(c.coinType) === coinSuffix(coinType))
    .reduce((sum, c) => sum + BigInt(c.amount), 0n);
  return { ok: tx.status.success && received >= BigInt(minAmount), received, checkpoint: tx.checkpoint };
}

export function explorerUrl(digest, network = NETWORK) {
  return `https://suiscan.xyz/${network}/tx/${digest}`;
}
