// Demo paid API with an x402-style flow, settled on Sui through Tatum.
//   GET <prefix>/quote?ticker=SUI -> 402 with terms and a signed challenge
//   retry with X-PAYMENT: {"challenge","transaction","signature"} -> settled once -> response
// Some tickers deliberately take payment and return junk, so an agent has something to learn from.
// The web app mounts it at /demo on its own origin; `npm run server` runs it alone.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { PaymentError } from "./payment.mjs";
import { createLedger, createPaywall } from "./paywall.mjs";

export const PRICE_MIST = 1_000_000n; // 0.001 SUI

const QUOTES = { SUI: 3.41, WAL: 0.52, BTC: 104250 };
const BROKEN = {
  ZZZ: { status: 200, body: {} }, // paid, empty payload
  FLAKY: { status: 502, body: { error: "upstream timeout" } }, // paid, upstream error
  GONE: { status: 410, body: { error: "ticker delisted" } }, // paid, permanent rejection
};

const RETRY_AFTER_SECONDS = 2;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function quote(ticker) {
  if (BROKEN[ticker]) return BROKEN[ticker];
  if (!(ticker in QUOTES)) return { status: 404, body: { error: "unknown ticker" } };
  return { status: 200, body: { ticker, priceUsd: QUOTES[ticker], asOf: new Date().toISOString() } };
}

// Request handler for the paid API, answering under `prefix`.
export function createProviderHandler(paywall, prefix = "") {
  return async (req, res) => {
    const url = new URL(req.url, "http://provider");
    if (req.method !== "GET" || url.pathname !== `${prefix}/quote`) return send(res, 404, { error: "not found" });
    const resource = url.pathname + url.search;

    const header = req.headers["x-payment"];
    if (!header) return send(res, 402, paywall.requirements(resource));
    try {
      await paywall.redeem(resource, header);
    } catch (err) {
      if (err instanceof PaymentError) return send(res, 402, { error: err.message, ...paywall.requirements(resource) });
      // The digest was released, so the client can retry the same signed payment once Sui is reachable.
      console.error("payment settlement failed:", err);
      return send(res, 503, { error: "payment settlement unavailable" }, { "retry-after": String(RETRY_AFTER_SECONDS) });
    }
    const { status, body } = quote((url.searchParams.get("ticker") ?? "").toUpperCase());
    send(res, status, body);
  };
}

export const createApp = (paywall, prefix) => createServer(createProviderHandler(paywall, prefix));

// The demo provider with payments settled and verified through Tatum.
export async function createProvider({ env = process.env, prefix = "" } = {}) {
  const { tatumSuiClient, settlePayment, NETWORK } = await import("./sui.mjs");
  const payTo = env.SERVER_SUI_ADDRESS;
  if (!payTo) throw new Error("SERVER_SUI_ADDRESS is required");
  const client = tatumSuiClient();
  const paywall = createPaywall({
    // Without a configured secret, challenges issued before a restart stop validating, which is safe.
    secret: env.SERVER_CHALLENGE_SECRET || randomBytes(32).toString("hex"),
    network: NETWORK,
    payTo,
    price: PRICE_MIST,
    // Kept with the rest of the persistent data, so replay protection survives a redeploy.
    ledger: createLedger(env.LEDGER_PATH ?? `${env.DATA_DIR ?? "data"}/used-digests.txt`),
    settlePayment: (signed, terms) => settlePayment(client, signed, terms),
  });
  return { handler: createProviderHandler(paywall, prefix), payTo, price: PRICE_MIST };
}

if (import.meta.main) {
  const port = Number(process.env.PROVIDER_PORT ?? 4020);
  const { handler, payTo } = await createProvider();
  createServer(handler).listen(port, "127.0.0.1", () => console.log(`paid API on http://localhost:${port}/quote payTo=${payTo}`));
}
