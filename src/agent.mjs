// Edith: pays for API calls, learns from every paid outcome, and declines payments its memory says are wasted.
// Usage: node --env-file=.env src/agent.mjs <url>
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { tatumSuiClient, explorerUrl, NETWORK } from "./sui.mjs";
import { createMemory, describeRequest, loadHistory, rememberEvent } from "./memory.mjs";
import { parseTerms, signProof } from "./payment.mjs";
import { classifyResponse, decide } from "./policy.mjs";

const MAX_PRICE_MIST = 5_000_000n; // hard spend cap per call: 0.005 SUI
const REDEEM_ATTEMPTS = 4;

const log = (...a) => console.log("[edith]", ...a);
const isUsefulQuote = (body) => typeof body?.priceUsd === "number";

// Money has already moved at this point. A 503 means the provider has not processed the proof,
// so the same proof is retried instead of being written off as a failed call.
async function redeem(url, header) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { "x-payment": header } });
    if (res.status !== 503 || attempt === REDEEM_ATTEMPTS) return res;
    const delayMs = Number(res.headers.get("retry-after") ?? 2) * 1000 * attempt;
    log(`provider could not verify the payment yet, retrying in ${delayMs / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

async function pay(sui, signer, { payTo, amount }) {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], payTo);
  const res = await sui.signAndExecuteTransaction({ transaction: tx, signer, include: { effects: true } });
  const done = res.Transaction ?? res.FailedTransaction;
  if (!done.status.success) throw new Error(`payment failed: ${JSON.stringify(done.status.error)}`);
  await sui.waitForTransaction({ digest: done.digest });
  return done.digest;
}

async function run(url) {
  if (!url) throw new Error("usage: agent.mjs <url>");
  if (!process.env.AGENT_SUI_PRIVATE_KEY) throw new Error("AGENT_SUI_PRIVATE_KEY is required");

  const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.AGENT_SUI_PRIVATE_KEY).secretKey);
  const sui = tatumSuiClient();
  const memory = createMemory();
  const request = describeRequest("GET", url);
  const context = { ...request, network: NETWORK };

  log(`request ${request.key} at ${request.provider} on ${NETWORK}`);
  const history = await loadHistory(memory, context);
  log(`memory: ${history.length} past paid outcomes for ${request.endpoint}`);

  const declined = async (decision) => {
    log(`decision: SKIP, ${decision.reason}`);
    await rememberEvent(memory, { event: "avoided", ...context, saved: decision.saved ?? 0, reason: decision.reason }, { wait: false });
    return 0;
  };

  // First pass without a price: known-bad requests are declined before the provider is even contacted.
  const early = decide(history, { key: request.key, now: Date.now() });
  if (early.action === "skip") return declined(early);

  const first = await fetch(url);
  if (first.status !== 402) {
    log(`no payment required, HTTP ${first.status}`);
    return 0;
  }
  const terms = parseTerms(await first.json(), NETWORK, MAX_PRICE_MIST);
  log(`402: ${terms.amount} MIST to ${terms.payTo.slice(0, 10)}...`);

  const decision = decide(history, { key: request.key, price: terms.amount, now: Date.now() });
  if (decision.action === "skip") return declined(decision);
  log(`decision: PAY, ${decision.reason}`);

  const digest = await pay(sui, signer, terms);
  log(`paid ${terms.amount} MIST, tx ${explorerUrl(digest)}`);

  const signature = await signProof(signer, terms.challenge, digest);
  const second = await redeem(url, JSON.stringify({ challenge: terms.challenge, digest, signature }));
  const body = await second.json().catch(() => null);
  const problem = classifyResponse(second.status, body, isUsefulQuote);
  const outcome = { event: "outcome", ...context, paid: terms.amount, digest };

  if (!problem) {
    log("result:", JSON.stringify(body));
    // Waited on: later decisions about this endpoint depend on successes as much as failures.
    await rememberEvent(memory, { ...outcome, result: "success" });
    return 0;
  }

  log(`BAD RESULT after paying: ${problem.reason} (${problem.kind})`);
  // Settled Sui payments cannot be reversed; the value here is never paying for this again.
  const saved = await rememberEvent(memory, { ...outcome, result: "failure", kind: problem.kind, reason: problem.reason });
  log(`remembered failure in Walrus Memory, blob ${saved.blob_id}`);
  return 1;
}

process.exitCode = await run(process.argv[2]);
