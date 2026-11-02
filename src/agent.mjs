// Edith: pays for API calls, remembers which paid calls were useless, and refuses to repeat them.
// Usage: node --env-file=.env src/agent.mjs <url>
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { tatumSuiClient, explorerUrl, NETWORK } from "./sui.mjs";
import { createMemory, requestKey, findFailure, rememberEvent } from "./memory.mjs";

const MAX_PRICE_MIST = 5_000_000n; // spend cap per call: 0.005 SUI

const log = (...a) => console.log("[edith]", ...a);

// A response is useful only if it is 200 with a numeric price.
function judge(status, body) {
  if (status !== 200) return `HTTP ${status} ${body?.error ?? ""}`.trim();
  if (typeof body?.priceUsd !== "number") return "empty or malformed payload";
  return null;
}

async function pay(sui, signer, requirement) {
  const amount = BigInt(requirement.maxAmountRequired);
  if (amount > MAX_PRICE_MIST) throw new Error(`price ${amount} MIST exceeds cap ${MAX_PRICE_MIST}`);
  if (requirement.network !== `sui:${NETWORK}`) throw new Error(`refusing to pay on ${requirement.network}, agent runs on ${NETWORK}`);
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], requirement.payTo);
  const res = await sui.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  const done = res.Transaction ?? res.FailedTransaction;
  if (!done.status.success) throw new Error(`payment failed: ${JSON.stringify(done.status.error)}`);
  await sui.waitForTransaction({ digest: done.digest });
  return { digest: done.digest, amount };
}

async function run(url) {
  if (!url) throw new Error("usage: agent.mjs <url>");
  if (!process.env.AGENT_SUI_PRIVATE_KEY) throw new Error("AGENT_SUI_PRIVATE_KEY is required");

  const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.AGENT_SUI_PRIVATE_KEY).secretKey);
  const sui = tatumSuiClient();
  const memory = createMemory();
  const key = requestKey("GET", url);

  log(`request ${key} on ${NETWORK}`);
  const past = await findFailure(memory, key, NETWORK);
  if (past) {
    log(`recalled: paid ${past.paid} MIST on ${past.at} and got "${past.reason}" (tx ${past.digest})`);
    log("decision: SKIP, not paying for a known-bad request again");
    await rememberEvent(memory, { event: "avoided", key, network: NETWORK, saved: past.paid, because: past.digest }, { wait: false });
    return 0;
  }
  log("no failure on record, proceeding");

  const first = await fetch(url);
  if (first.status !== 402) {
    log(`no payment required, HTTP ${first.status}`);
    return 0;
  }
  const requirement = (await first.json()).accepts[0];
  log(`402: ${requirement.maxAmountRequired} MIST to ${requirement.payTo.slice(0, 10)}...`);

  const payment = await pay(sui, signer, requirement);
  log(`paid ${payment.amount} MIST, tx ${explorerUrl(payment.digest)}`);

  const second = await fetch(url, { headers: { "x-payment": JSON.stringify({ network: NETWORK, digest: payment.digest }) } });
  const body = await second.json().catch(() => null);
  const problem = judge(second.status, body);
  if (!problem) {
    log("result:", JSON.stringify(body));
    return 0;
  }

  log(`BAD RESULT after paying: ${problem}`);
  // Settled Sui payments cannot be reversed; the value here is never paying for this again.
  const saved = await rememberEvent(memory, { event: "failure", key, network: NETWORK, paid: payment.amount, digest: payment.digest, reason: problem });
  log(`remembered failure in Walrus Memory, blob ${saved.blob_id}`);
  return 1;
}

process.exitCode = await run(process.argv[2]);
