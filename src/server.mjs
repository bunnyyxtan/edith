// Demo paid API with an x402-style flow, settled on Sui and verified through Tatum.
//   GET /quote?ticker=SUI  -> 402 with payment requirements
//   retry with X-PAYMENT: {"network","digest"} -> verified -> response
// Some tickers deliberately take payment and return junk, so the agent has something to learn from.
import { createServer } from "node:http";
import { tatumSuiClient, verifyPayment, NETWORK, SUI } from "./sui.mjs";

const PORT = Number(process.env.PORT ?? 4020);
const PRICE_MIST = 1_000_000n; // 0.001 SUI
const PAY_TO = process.env.SERVER_SUI_ADDRESS;
if (!PAY_TO) throw new Error("SERVER_SUI_ADDRESS is required");

const client = tatumSuiClient();
// Replay guard is in-memory and resets on restart; persist used digests before running this beyond a demo.
const usedDigests = new Set();

const QUOTES = { SUI: 3.41, WAL: 0.52, BTC: 104250 };
const BROKEN = {
  ZZZ: () => ({ status: 200, body: {} }), // paid, empty payload
  FLAKY: () => ({ status: 502, body: { error: "upstream timeout" } }), // paid, upstream error
};

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function requirements(resource) {
  return { x402Version: 1, accepts: [{ scheme: "exact", network: `sui:${NETWORK}`, payTo: PAY_TO, maxAmountRequired: String(PRICE_MIST), asset: SUI, resource }] };
}

async function handleQuote(req, res, url) {
  const header = req.headers["x-payment"];
  if (!header) return send(res, 402, requirements(url.pathname + url.search));

  let digest;
  try {
    ({ digest } = JSON.parse(header));
  } catch {
    return send(res, 400, { error: "X-PAYMENT must be JSON {network, digest}" });
  }
  if (!digest || usedDigests.has(digest)) return send(res, 402, { error: "payment missing or already used", ...requirements(url.pathname + url.search) });

  const check = await verifyPayment(client, digest, { payTo: PAY_TO, minAmount: PRICE_MIST });
  if (!check.ok) return send(res, 402, { error: "payment not verified", received: String(check.received) });
  usedDigests.add(digest);

  const ticker = (url.searchParams.get("ticker") ?? "").toUpperCase();
  if (BROKEN[ticker]) {
    const { status, body } = BROKEN[ticker]();
    return send(res, status, body);
  }
  if (!(ticker in QUOTES)) return send(res, 404, { error: "unknown ticker" });
  return send(res, 200, { ticker, priceUsd: QUOTES[ticker], asOf: new Date().toISOString() });
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/quote") return await handleQuote(req, res, url);
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error("request failed:", err);
    send(res, 500, { error: "internal error" });
  }
}).listen(PORT, () => console.log(`paid API on http://localhost:${PORT} network=${NETWORK} payTo=${PAY_TO}`));
