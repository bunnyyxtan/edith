// One-time setup: create the agent (payer) and demo API (payee) keypairs in .env.
// On devnet the agent is funded from the public faucet; on testnet and mainnet it must be funded manually.
// Prints addresses only, never keys.
import { readFileSync, writeFileSync } from "node:fs";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { NETWORK } from "../src/sui.mjs";

const ENV = ".env";
let env = readFileSync(ENV, "utf8");

function setValue(name, value) {
  const match = env.match(new RegExp(`^${name}=.*$`, "m"));
  env = match ? env.replace(match[0], `${name}=${value}`) : `${env.trimEnd()}\n${name}=${value}\n`;
}

function ensureKeypair(name) {
  const existing = env.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1].trim();
  if (existing) return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(existing).secretKey);
  const keypair = new Ed25519Keypair();
  setValue(name, keypair.getSecretKey());
  return keypair;
}

const agent = ensureKeypair("AGENT_SUI_PRIVATE_KEY");
const server = ensureKeypair("SERVER_SUI_PRIVATE_KEY");
setValue("SERVER_SUI_ADDRESS", server.toSuiAddress());
writeFileSync(ENV, env);

console.log("agent address: ", agent.toSuiAddress());
console.log("server address:", server.toSuiAddress());

if (NETWORK === "devnet") {
  await requestSuiFromFaucetV2({ host: getFaucetHost("devnet"), recipient: agent.toSuiAddress() });
  console.log("agent funded from the devnet faucet");
} else {
  console.log(`fund the agent address with SUI on ${NETWORK} before running the agent`);
}
