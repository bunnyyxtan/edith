// Read-only connectivity check for Tatum (Sui gRPC) and Walrus Memory. Writes nothing.
import { tatumSuiClient, NETWORK } from "../src/sui.mjs";
import { createMemory } from "../src/memory.mjs";

async function check(name, fn) {
  try {
    console.log(`ok    ${name}: ${await fn()}`);
    return true;
  } catch (err) {
    console.log(`FAIL  ${name}: ${err.message}`);
    return false;
  }
}

const results = [
  await check(`tatum sui ${NETWORK}`, async () => {
    const { response } = await tatumSuiClient().ledgerService.getServiceInfo({});
    return `chain ${response.chainId}, checkpoint ${response.checkpointHeight}`;
  }),
  await check("walrus memory", async () => {
    const health = await createMemory().health();
    if (!health.write_ready) throw new Error(`relayer not write-ready (status ${health.status})`);
    return `relayer ${health.version}, write-ready`;
  }),
];

process.exitCode = results.every(Boolean) ? 0 : 1;
