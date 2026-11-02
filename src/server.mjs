// Demo paid API with an x402-style flow, settled on Sui and verified through Tatum.
//   GET /quote?ticker=SUI -> 402 with terms and a signed challenge
//   retry with X-PAYMENT: {"challenge","digest","signature"} -> verified once -> response
// Some tickers deliberately take payment and return junk, so the agent has something to learn from.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { PaymentError } from "./payment.mjs";
import { createLedger, createPaywall } from "./paywall.mjs";

const PRICE_MIST = 1_000_000n; // 0.001 SUI

const QUOTES = { SUI: 3.41, WAL: 0.52, BTC: 104250 };
const BROKEN = {
  ZZZ: { status: 200, body: {} }, // paid, empty payload
  FLAKY: { status: 502, body: { error: "upstream timeout" } }, // paid, upstream error
  GONE: { status: 410, body: { error: "ticker delisted" } }, // paid, permanent rejection
};

const RETRY_AFTER_SECONDS = 2;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function quote(ticker) {
  if (BROKEN[ticker]) return BROKEN[ticker];
  if (!(ticker in QUOTES)) return { status: 404, body: { error: "unknown ticker" } };
  return { status: 200, body: { ticker, priceUsd: QUOTES[ticker], asOf: new Date().toISOString() } };
}

export function createApp(paywall) {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method !== "GET" || url.pathname !== "/quote") return send(res, 404, { error: "not found" });
    const resource = url.pathname + url.search;

    const header = req.headers["x-payment"];
    if (!header) return send(res, 402, paywall.requirements(resource));
    try {
      await paywall.redeem(resource, header);
    } catch (err) {
      if (err instanceof PaymentError) return send(res, 402, { error: err.message, ...paywall.requirements(resource) });
      // The digest was released, so the client can retry the same proof once verification recovers.
      console.error("payment verification failed:", err);
      return send(res, 503, { error: "payment verification unavailable" }, { "retry-after": String(RETRY_AFTER_SECONDS) });
    }
    const { status, body } = quote((url.searchParams.get("ticker") ?? "").toUpperCase());
    send(res, status, body);
  });
}

if (import.meta.main) {
  const { tatumSuiClient, verifyPayment, NETWORK } = await import("./sui.mjs");
  const payTo = process.env.SERVER_SUI_ADDRESS;
  if (!payTo) throw new Error("SERVER_SUI_ADDRESS is required");
  const port = Number(process.env.PORT ?? 4020);
  const client = tatumSuiClient();
  const paywall = createPaywall({
    // Without a configured secret, challenges issued before a restart stop validating, which is safe.
    secret: process.env.SERVER_CHALLENGE_SECRET || randomBytes(32).toString("hex"),
    network: NETWORK,
    payTo,
    price: PRICE_MIST,
    ledger: createLedger(process.env.LEDGER_PATH ?? "data/used-digests.txt"),
    lookupPayment: (digest, terms) => verifyPayment(client, digest, terms),
  });
  createApp(paywall).listen(port, () => console.log(`paid API on http://localhost:${port} network=${NETWORK} payTo=${payTo}`));
}
