// A minimal agent that uses Edith the way any agent would: with its own Edith agent key, never a wallet.
// It asks about a paid URL, then waits while its owner approves (or Edith refuses) and prints the outcome.
//
//   EDITH_AGENT_KEY=ek_... npm run agent -- <url> [<url> ...]
//   EDITH_URL defaults to http://localhost:4030
const BASE = (process.env.EDITH_URL ?? "http://localhost:4030").replace(/\/+$/, "");
const KEY = process.env.EDITH_AGENT_KEY;
const POLL_MS = 3000;
const WAIT_MS = 15 * 60_000; // how long this agent is willing to wait for its owner
const DONE = new Set(["paid", "blocked", "free", "cancelled", "expired", "failed", "refused"]);

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${data.error ?? "request failed"}`);
  return data;
}

function report(r) {
  const amount = r.amountMist ? `${Number(r.amountMist) / 1e9} SUI` : "";
  if (r.state === "blocked") return `REFUSED by Edith (${r.decision?.source}): ${r.decision?.reason}`;
  if (r.state === "paid") return `PAID ${amount}, ${r.result === "success" ? "useful answer" : `worthless answer (${r.problem?.reason})`}\n  tx ${r.digest}\n  memory ${r.blobId}\n  answer ${(r.body ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
  if (r.state === "free") return `FREE: no payment needed (HTTP ${r.status})`;
  return `${r.state.toUpperCase()}${r.error ? `: ${r.error}` : ""}`;
}

async function ask(url) {
  let r = await call("POST", "/v1/requests", { url });
  console.log(`\n${url}\n  Edith: ${r.state}${r.state === "awaiting" ? ` ${Number(r.amountMist) / 1e9} SUI, approve it in Edith: ${r.approval.review}` : ""}`);
  const deadline = Date.now() + WAIT_MS;
  while (r.state === "awaiting" || r.state === "settling" || r.state === "uncertain") {
    if (Date.now() > deadline) return console.log("  gave up waiting for approval");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    r = await call("GET", `/v1/requests/${r.id}`);
  }
  console.log(`  ${DONE.has(r.state) ? report(r) : r.state}`);
}

if (!KEY) {
  console.error("Set EDITH_AGENT_KEY to a key from Edith's Agents page.");
  process.exit(1);
}
const urls = process.argv.slice(2);
if (!urls.length) {
  console.error("usage: npm run agent -- <paid url> [<paid url> ...]");
  process.exit(1);
}
for (const url of urls) {
  try {
    await ask(url);
  } catch (err) {
    console.log(`\n${url}\n  error ${err.message}`);
  }
}
