// Test double for Sui: real signed transfers built offline, and a fake chain that executes them.
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { fromBase64, toBase64 } from "@mysten/sui/utils";
import { transactionDigest } from "../src/payment.mjs";

const GAS_COIN = { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd" };
const SUI = "0x2::sui::SUI";
let nonce = 0;

// A real transfer the payer's wallet would sign, with a fixed gas coin so no client is needed to build it.
// A unique gas budget gives every transfer its own digest.
export async function signedTransfer({ payer = new Ed25519Keypair(), payTo, amount, sender = payer.toSuiAddress() }) {
  const tx = new Transaction();
  tx.setSender(sender);
  tx.setGasPrice(1000);
  tx.setGasBudget(5_000_000 + nonce++);
  tx.setGasPayment([GAS_COIN]);
  const [coin] = tx.splitCoins(tx.gas, [BigInt(amount)]);
  tx.transferObjects([coin], payTo);
  const bytes = await tx.build();
  const { signature } = await payer.signTransaction(bytes);
  return { payer, bytes, digest: transactionDigest(bytes), transaction: toBase64(bytes), signature, effects: { sender, payTo, amount: BigInt(amount) } };
}

// Transfers are registered before use; executing one makes it visible to getTransaction.
// `overrides[digest]` changes what the chain reports (failure, other payee, no timestamp, thrown error).
// What a plain SUI transfer pays, read from its bytes.
export function transferEffects(bytes) {
  const data = Transaction.from(bytes).getData();
  const pure = data.inputs.filter((i) => i.Pure).map((i) => fromBase64(i.Pure.bytes));
  return { sender: data.sender, amount: BigInt(bcs.u64().parse(pure[0])), payTo: bcs.Address.parse(pure[1]) };
}

// autoRegister: accept any well-formed transfer without registering it first (for the QA harness).
export function fakeChain({ now = () => Date.now(), autoRegister = false } = {}) {
  const known = new Map();
  const learn = (bytes) => {
    const digest = transactionDigest(bytes);
    if (autoRegister && !known.has(digest)) known.set(digest, transferEffects(bytes));
    return digest;
  };
  const landed = new Map();
  const overrides = {};
  const calls = { execute: 0, simulate: 0 };

  const view = (digest) => {
    const { sender, payTo, amount } = known.get(digest);
    const o = overrides[digest] ?? {};
    if (o.throws) throw o.throws;
    return {
      Transaction: {
        status: { success: o.success ?? true, error: o.success === false ? { message: "InsufficientGas" } : undefined },
        balanceChanges: [
          { address: sender, coinType: SUI, amount: String(-amount) },
          { address: o.payTo ?? payTo, coinType: SUI, amount: String(o.amount ?? amount) },
        ],
        transaction: { sender },
        timestampMs: "timestampMs" in o ? o.timestampMs : landed.get(digest),
      },
    };
  };

  const client = {
    core: {
      async simulateTransaction({ transaction }) {
        calls.simulate++;
        return view(learn(transaction));
      },
      async executeTransaction({ transaction }) {
        calls.execute++;
        const digest = learn(transaction);
        if (!known.has(digest)) throw Object.assign(new Error("unknown transaction"), { code: "INVALID_ARGUMENT" });
        if (overrides[digest]?.executeThrows) throw overrides[digest].executeThrows;
        if (!landed.has(digest)) landed.set(digest, now());
        return view(digest);
      },
      async waitForTransaction() {},
      async getTransaction({ digest }) {
        if (!landed.has(digest)) throw Object.assign(new Error("not found"), { code: "NOT_FOUND" });
        return view(digest);
      },
      async getBalance() {
        return { balance: { balance: "123000000" } };
      },
    },
  };
  return {
    client,
    calls,
    overrides,
    landed,
    register: (t) => known.set(t.digest, t.effects),
    land: (digest, at = now()) => landed.set(digest, at),
  };
}
