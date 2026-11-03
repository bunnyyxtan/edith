// Production check against a running Edith (default http://localhost:4030), through its public HTTP API only.
//
//   node scripts/mainnet-check.mjs                 no funds move: fresh throwaway wallets, real Tatum and Walrus
//   node scripts/mainnet-check.mjs --slow          adds the expired-quote check (waits about 4.5 minutes)
//   EDITH_SMOKE_KEY=suiprivkey... node scripts/mainnet-check.mjs --pay
//                                                  ALSO spends real SUI from that wallet: two 0.001 SUI demo
//                                                  payments plus gas. Use a separate wallet holding ~0.01 SUI.
//
// Every check prints PASS or FAIL; the exit code is the number of failures.
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

const BASE = (process.env.EDITH_URL ?? "http://localhost:4030").replace(/\/+$/, "");
const args = new Set(process.argv.slice(2));
let failures = 0;

function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// One signed-in person, with their own cookie, talking to the API the way the web app does.
async function person(keypair = new Ed25519Keypair()) {
  const address = keypair.toSuiAddress();
  let cookie = "";
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(method === "GET" ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
    return { status: res.status, data, setCookie: res.headers.get("set-cookie") };
  };
  const { data: { message } } = await call("POST", "/api/session/challenge", { address });
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));
  const signedIn = await call("POST", "/api/session", { message, signature });
  cookie = signedIn.setCookie?.split(";")[0] ?? "";
  return { keypair, address, call, signedIn };
}

const agentCall = (token) => async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

async function connectAgent(p, name) {
  const { data } = await p.call("POST", "/api/agents", { name });
  return { ...data, call: agentCall(data.token) };
}

// A transfer signed by an unfunded wallet, with a made-up gas coin. Sui will refuse it; nothing can move.
async function unfundedTransfer(keypair, { payTo, amount }) {
  const tx = new Transaction();
  tx.setSender(keypair.toSuiAddress());
  tx.setGasPrice(1000);
  tx.setGasBudget(5_000_000);
  tx.setGasPayment([{ objectId: `0x${"1".repeat(64)}`, version: "1", digest: "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd" }]);
  const [coin] = tx.splitCoins(tx.gas, [BigInt(amount)]);
  tx.transferObjects([coin], payTo);
  const bytes = await tx.build();
  const { signature } = await keypair.signTransaction(bytes);
  return { transaction: toBase64(bytes), signature };
}

async function noSpendChecks() {
  console.log(`\nEdith at ${BASE}: checks that move no funds\n`);
  const config = (await (await fetch(`${BASE}/api/config`)).json());
  check("config is served", Boolean(config.network), `network ${config.network}`);
  const demo = config.demo.baseUrl;

  const alice = await person();
  check("wallet sign-in verifies a real signature", alice.signedIn.status === 200);
  const replay = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  check("sign-in without a signed message is refused", replay.status === 401, `HTTP ${replay.status}`);

  const balance = await alice.call("GET", "/api/balance");
  check("balance is read from Sui through Tatum", balance.status === 200 && balance.data.mist === "0", `HTTP ${balance.status}, ${balance.data?.mist ?? balance.data?.error} MIST`);

  const limits = await alice.call("PUT", "/api/limits", { perCallMist: "5000000", dailyMist: "20000000" });
  check("limits are confirmed", limits.status === 200 && Boolean(limits.data.limitsSetAt));

  const bot = await connectAgent(alice, "Prod check agent");
  check("an agent key is issued once, its hash kept private", /^ek_[0-9a-f]{64}\./.test(bot.token ?? "") && bot.agent.secretHash === undefined);

  const asked = await bot.call("POST", "/v1/requests", { url: `${demo}?ticker=SUI` });
  check("an agent's paid request recalls Walrus Memory and waits for approval", asked.status === 200 && asked.data.state === "awaiting", `${asked.data?.state ?? asked.data?.error}`);
  const me = (await alice.call("GET", "/api/me")).data;
  const item = me.activity.find((a) => a.id === asked.data.id);
  check("the owner sees it, attributed to the agent", item?.source?.name === "Prod check agent");

  const signed = await unfundedTransfer(alice.keypair, item.terms);
  const [first, second] = await Promise.all([alice.call("POST", `/api/requests/${item.id}/pay`, signed), alice.call("POST", `/api/requests/${item.id}/pay`, signed)]);
  const statuses = [first.status, second.status].sort();
  check("a double submit settles at most once", statuses[0] === 200 && statuses[1] === 409, statuses.join(", "));
  const last = [first, second].find((r) => r.status === 200).data.at(-1);
  check("a transfer Sui would refuse is never sent, and says why", last.step === "error" && last.activity?.state === "failed" && /would fail on Sui|couldn't|Nothing was paid|did not send/i.test(last.message), last.message);
  const again = await alice.call("POST", `/api/requests/${item.id}/pay`, signed);
  check("a failed request cannot be paid again", again.status === 404, `HTTP ${again.status}`);
  const after = (await alice.call("GET", "/api/me")).data;
  check("nothing counts against the limit after a failed payment", after.spentMist === "0", `${after.spentMist} MIST`);

  const bob = await person();
  const bobBot = await connectAgent(bob, "Other wallet agent");
  check("another wallet's agent cannot read this request", (await bobBot.call("GET", `/v1/requests/${asked.data.id}`)).status === 404);
  check("another wallet cannot pay this request", (await bob.call("POST", `/api/requests/${item.id}/pay`, signed)).status === 404);
  check("another wallet's activity stays empty", (await bob.call("GET", "/api/me")).data.activity.length === 0);
  check("an agent key is not a session", (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${bot.token}` } })).status === 401);

  const internal = await bot.call("POST", "/v1/requests", { url: "http://169.254.169.254/latest/meta-data" });
  check("internal addresses are refused", internal.status === 422 || internal.status === 400, `${internal.status} ${internal.data?.error}`);
  const missing = await bot.call("POST", "/v1/requests", { url: "https://no-such-host.invalid/quote" });
  check("an unreachable provider fails cleanly, nothing paid", missing.status === 422 || missing.status === 400, `${missing.status} ${missing.data?.error}`);
  const junk = await bot.call("POST", "/v1/requests", { url: "not a url" });
  check("a malformed URL is refused", junk.status === 400, `${junk.status} ${junk.data?.error}`);

  const withdrawn = await bot.call("POST", "/v1/requests", { url: `${demo}?ticker=WAL` });
  const cancel = await bot.call("POST", `/v1/requests/${withdrawn.data.id}/cancel`);
  check("an agent can withdraw a waiting request", cancel.data?.state === "cancelled");

  await alice.call("POST", `/api/agents/${bot.agent.id}/revoke`);
  check("a disconnected agent is locked out", (await bot.call("GET", `/v1/requests/${asked.data.id}`)).status === 401);

  await alice.call("PUT", "/api/limits", { perCallMist: "500000", dailyMist: "20000000" });
  const held = await alice.call("POST", "/api/requests", { url: `${demo}?ticker=SUI` });
  const heldItem = held.data.at(-1).activity;
  check("a price over the limit is held before any wallet prompt", heldItem?.state === "blocked" && heldItem.decision?.source === "limit", heldItem?.decision?.reason);

  if (args.has("--slow")) await expiryCheck(alice);
}

// The 4-minute quote runs out; the agent's request keeps waiting and gets a fresh price on review.
async function expiryCheck(p) {
  await p.call("PUT", "/api/limits", { perCallMist: "5000000", dailyMist: "20000000" });
  const bot = await connectAgent(p, "Patient agent");
  const demo = (await (await fetch(`${BASE}/api/config`)).json()).demo.baseUrl;
  const asked = await bot.call("POST", "/v1/requests", { url: `${demo}?ticker=BTC` });
  console.log("      waiting 4.5 minutes for the quote to expire…");
  await new Promise((r) => setTimeout(r, 270_000));
  const stale = (await p.call("GET", "/api/me")).data.activity.find((a) => a.id === asked.data.id);
  check("an expired agent quote still waits for its owner", stale?.state === "awaiting" && stale.stale === true);
  const fresh = await p.call("POST", `/api/requests/${asked.data.id}/requote`);
  check("review fetches a fresh price", fresh.data?.activity?.state === "awaiting" && Date.parse(fresh.data.activity.expiresAt) > Date.now());
  await bot.call("POST", `/v1/requests/${asked.data.id}/cancel`);
}

// The paid leg: real SUI from the wallet in EDITH_SMOKE_KEY, signed here the way a browser wallet would.
async function paidChecks() {
  if (!process.env.EDITH_SMOKE_KEY) throw new Error("--pay needs EDITH_SMOKE_KEY (a separate, minimally funded wallet)");
  const { tatumSuiClient } = await import("../src/sui.mjs"); // the wallet's own view of the chain, to pick gas
  const keypair = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(process.env.EDITH_SMOKE_KEY).secretKey);
  const client = tatumSuiClient();
  console.log(`\nPaid checks from ${keypair.toSuiAddress()} (spends about 0.002 SUI plus gas)\n`);

  const p = await person(keypair);
  await p.call("PUT", "/api/limits", { perCallMist: "5000000", dailyMist: "20000000" });
  const before = BigInt((await p.call("GET", "/api/balance")).data.mist);
  check("the smoke wallet holds enough SUI", before >= 5_000_000n, `${before} MIST`);
  const bot = await connectAgent(p, "Smoke agent");
  const demo = (await (await fetch(`${BASE}/api/config`)).json()).demo.baseUrl;

  const approve = async (id) => {
    const item = (await p.call("GET", "/api/me")).data.activity.find((a) => a.id === id);
    const tx = new Transaction();
    tx.setSender(keypair.toSuiAddress());
    const [coin] = tx.splitCoins(tx.gas, [BigInt(item.terms.amount)]);
    tx.transferObjects([coin], item.terms.payTo);
    const bytes = await tx.build({ client });
    const { signature } = await keypair.signTransaction(bytes);
    const res = await p.call("POST", `/api/requests/${id}/pay`, { transaction: toBase64(bytes), signature });
    return { res, signed: { transaction: toBase64(bytes), signature } };
  };

  const good = await bot.call("POST", "/v1/requests", { url: `${demo}?ticker=SUI` });
  const { res: paid, signed } = await approve(good.data.id);
  const done = paid.data.at(-1);
  check("an approved payment settles and is verified on Sui", done.step === "settled" && done.activity.state === "paid" && done.activity.result === "success", done.message ?? done.activity?.digest);
  const answer = await bot.call("GET", `/v1/requests/${good.data.id}`);
  check("the agent receives the provider's answer", answer.data.state === "paid" && /SUI/.test(answer.data.body ?? ""), answer.data.digest);
  const replay = await p.call("POST", `/api/requests/${good.data.id}/pay`, signed);
  check("the same signed transfer cannot pay twice", replay.status === 404, `HTTP ${replay.status}`);

  const bad = await bot.call("POST", "/v1/requests", { url: `${demo}?ticker=ZZZ` });
  const { res: paidBad } = await approve(bad.data.id);
  const badDone = paidBad.data.at(-1);
  check("a worthless answer is judged and saved to Walrus Memory", badDone.activity?.result === "failure" && badDone.activity.memory === "saved" && Boolean(badDone.activity.blobId), badDone.activity?.blobId ?? badDone.message);

  const repeat = await bot.call("POST", "/v1/requests", { url: `${demo}?ticker=ZZZ` });
  check("the repeat is refused from memory, citing the paid failure", repeat.data.state === "blocked" && repeat.data.decision?.source === "memory", repeat.data.decision?.reason);
  const memory = await p.call("GET", `/api/memory?url=${encodeURIComponent(`${demo}?ticker=ZZZ`)}`);
  check("Walrus Memory returns the remembered failure", memory.data.records?.some((r) => r.event === "paid" && r.result === "failure"), `${memory.data.records?.length} records`);

  const afterBalance = BigInt((await p.call("GET", "/api/balance")).data.mist);
  console.log(`      spent ${before - afterBalance} MIST in total, gas included`);
}

try {
  await noSpendChecks();
  if (args.has("--pay")) await paidChecks();
} catch (err) {
  failures++;
  console.log(`FAIL  the check itself stopped: ${err.message}`);
}
console.log(`\n${failures ? `${failures} failed` : "all passed"}`);
process.exit(failures);
