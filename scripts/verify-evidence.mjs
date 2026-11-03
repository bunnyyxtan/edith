// Re-checks, independently of the app, the evidence behind one wallet's activity. Read only: it moves nothing.
//   node --env-file=.env scripts/verify-evidence.mjs <wallet address>
// For every paid request: the transaction succeeded on Sui (through Tatum), was sent by that wallet, and
// credited the provider at least the quoted amount in native SUI. For every outcome Edith says it learned:
// Walrus Memory (that wallet's namespace) returns the record, with the same transaction digest. For every
// refusal from memory: the paid failure it cites exists on chain.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { tatumSuiClient, verifyPayment, NETWORK } from "../src/sui.mjs";
import { createMemory, describeRequest, loadRecords, userNamespace } from "../src/memory.mjs";

const address = normalizeSuiAddress(String(process.argv[2] ?? ""));
if (!/^0x[0-9a-f]{64}$/.test(address) || address === normalizeSuiAddress("0x0")) {
  console.error("usage: node --env-file=.env scripts/verify-evidence.mjs <wallet address>");
  process.exit(1);
}

const user = JSON.parse(await readFile(join(process.env.DATA_DIR ?? "data", "users", `${address}.json`), "utf8"));
const sui = tatumSuiClient();
const memory = createMemory();
let failures = 0;
const check = (ok, name, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const paid = user.activity.filter((a) => a.state === "paid" && a.digest);
const refused = user.activity.filter((a) => a.state === "blocked" && a.decision?.source === "memory");
console.log(`${address} on ${NETWORK}: ${paid.length} paid, ${refused.length} refused from memory\n`);

for (const a of paid) {
  const terms = { payTo: a.terms.payTo, minAmount: BigInt(a.terms.amount) };
  const v = await verifyPayment(sui, a.digest, terms);
  check(v.ok && normalizeSuiAddress(v.sender ?? "0x0") === address,
    `${a.request} paid ${Number(a.amountMist) / 1e9} SUI`,
    `tx https://suiscan.xyz/${NETWORK}/tx/${a.digest}  received ${v.received} MIST, sender ${v.sender === null ? "unknown" : normalizeSuiAddress(v.sender) === address ? "this wallet" : v.sender}`);

  const { endpoint, provider } = describeRequest("GET", a.url);
  const records = await loadRecords(memory, { endpoint, provider, network: NETWORK }, userNamespace(address));
  const record = records.find((r) => r.event === "outcome" && r.digest === a.digest);
  check(Boolean(record) && (!a.blobId || record.blobId === a.blobId),
    `  remembered in Walrus Memory as ${record?.result ?? "nothing"}`,
    `blob ${record?.blobId ?? "missing"} (app shows ${a.blobId ?? "none"})`);
}

for (const a of refused) {
  const cited = a.decision.basis?.digest;
  const original = paid.find((p) => p.digest === cited);
  const v = cited && original ? await verifyPayment(sui, cited, { payTo: original.terms.payTo, minAmount: 1n }) : { ok: false };
  check(v.ok, `${a.request} refused, citing a paid failure that is on chain`, `cites ${cited ?? "nothing"}`);
}

console.log(`\n${failures ? `${failures} failed` : "all evidence verified"}`);
process.exit(failures);
