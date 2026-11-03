// Command-line Edith for an operator's own agent key: plans a request and, when memory allows it,
// signs the quoted transfer with that key and settles it. The web app uses each person's wallet instead.
// Usage: node --env-file=.env src/agent.mjs <url>
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { toBase64 } from "@mysten/sui/utils";
import { tatumSuiClient, explorerUrl, NETWORK } from "./sui.mjs";
import { createMemory } from "./memory.mjs";
import { createEdith, transferTransaction } from "./edith.mjs";

const log = (...a) => console.log("[edith]", ...a);

const narrate = {
  recalled: (e) => log(`memory: ${e.history.length} past paid outcomes for this endpoint`),
  quoted: (e) => log(`402: ${e.terms.amount} MIST to ${e.terms.payTo.slice(0, 10)}...`),
  paying: (e) => log(`sending signed transfer ${e.digest} to the provider`),
  verified: (e) => log(`settled, tx ${explorerUrl(e.digest)}`),
  retrying: (e) => log(`provider could not settle yet, retrying in ${e.delayMs / 1000}s`),
  judged: (e) => log(e.problem ? `BAD RESULT after paying: ${e.problem.reason} (${e.problem.kind})` : `result: ${JSON.stringify(e.body)}`),
  remembered: (e) => log(`remembered in Walrus Memory, blob ${e.blobId}`),
};
const emit = (event) => narrate[event.step]?.(event);

async function run(url) {
  if (!url) throw new Error("usage: agent.mjs <url>");
  if (!process.env.AGENT_SUI_PRIVATE_KEY) throw new Error("AGENT_SUI_PRIVATE_KEY is required");
  const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.AGENT_SUI_PRIVATE_KEY).secretKey);
  const sui = tatumSuiClient();
  const edith = createEdith({ sui, memory: createMemory(), network: NETWORK, payer: signer.toSuiAddress() });

  log(`request ${url} on ${NETWORK}`);
  const planned = await edith.plan(url, {}, emit);
  if (planned.action === "skip") {
    log(`decision: SKIP, ${planned.decision.reason}`);
    return 0;
  }
  if (planned.action === "free") {
    log(`no payment required, HTTP ${planned.status}`);
    return 0;
  }
  log(`decision: PAY, ${planned.decision.reason}`);
  const bytes = await transferTransaction(planned.terms, signer.toSuiAddress()).build({ client: sui });
  const { signature } = await signer.signTransaction(bytes);
  const settled = await edith.settle(planned, { transaction: toBase64(bytes), signature }, emit);
  return settled.result === "success" ? 0 : 1;
}

process.exitCode = await run(process.argv[2]);
