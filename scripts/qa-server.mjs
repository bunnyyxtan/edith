// Local QA harness, never deployed: the real web app and API over a fake chain and MemWalMock, plus a
// throwaway test wallet whose key lives here, so every screen and state can be exercised without real SUI.
//   npm run qa   then open http://127.0.0.1:4031/app and load /qa/wallet.js into the page
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { MemWalMock } from "@mysten-incubation/memwal";
import { createApi } from "../src/api.mjs";
import { createAuth } from "../src/auth.mjs";
import { createProviderFetch } from "../src/net.mjs";
import { createLedger, createPaywall } from "../src/paywall.mjs";
import { createProviderHandler } from "../src/server.mjs";
import { createStore } from "../src/store.mjs";
import { settlePayment } from "../src/sui.mjs";
import { fakeChain } from "../test/chain.mjs";

if (process.env.NODE_ENV === "production") throw new Error("the QA harness never runs in production");

const PORT = Number(process.env.QA_PORT ?? 4031);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PAY_TO = `0x${"d".repeat(64)}`;
const GAS_COIN = { objectId: `0x${"1".repeat(64)}`, version: "1", digest: "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd" };
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

const wallet = new Ed25519Keypair();
const chain = fakeChain({ autoRegister: true });
const paywall = createPaywall({
  secret: "qa", network: "mainnet", payTo: PAY_TO, price: 1_000_000n,
  ledger: createLedger(join(tmp("edith-qa-"), "used.txt")),
  settlePayment: (payment, terms) => settlePayment(chain.client, payment, terms),
});
const api = createApi({
  sui: chain.client, network: "mainnet", memory: new MemWalMock({ namespace: "edith" }),
  store: createStore(tmp("edith-qa-users-")),
  auth: createAuth({ secret: "qa", origin: ORIGIN, network: "mainnet", client: chain.client }),
  providerFetch: createProviderFetch({ allowPrivate: true }),
  demo: { name: "Quote Desk", baseUrl: `${ORIGIN}/demo/quote`, priceMist: 1_000_000n, payTo: PAY_TO, handler: createProviderHandler(paywall, "/demo") },
  staticDir: "web/dist", origin: ORIGIN,
});
const handleApi = api.listeners("request")[0];

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const send = (res, data, type = "application/json") => {
  res.writeHead(200, { "content-type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : data);
};

const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#011829"/><circle cx="20" cy="20" r="8" fill="#4da2ff"/></svg>').toString("base64");

// Registers the test wallet with the page through the Wallet Standard. Signing happens in this process.
// window.qaDecline(true) makes it refuse, like a person pressing Reject.
const walletScript = () => `(() => {
  const address = ${JSON.stringify(wallet.toSuiAddress())};
  const publicKey = new Uint8Array(${JSON.stringify([...wallet.getPublicKey().toRawBytes()])});
  const post = (path, data) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }).then((r) => r.json());
  const account = { address, publicKey, chains: ["sui:mainnet"], features: ["sui:signPersonalMessage", "sui:signTransaction"] };
  let decline = false;
  window.qaDecline = (v = true) => { decline = v; };
  const refuse = () => Promise.reject(Object.assign(new Error("User rejected the request"), { code: 4001 }));
  const w = {
    version: "1.0.0", name: "QA Wallet", chains: ["sui:mainnet"], accounts: [account],
    icon: "data:image/svg+xml;base64,${ICON}",
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => ({ accounts: [account] }) },
      "standard:events": { version: "1.0.0", on: () => () => {} },
      "sui:signPersonalMessage": { version: "1.1.0", signPersonalMessage: async ({ message }) => decline ? refuse() : post("/qa/sign-message", { message: Array.from(message) }) },
      "sui:signTransaction": { version: "2.0.0", signTransaction: async ({ transaction }) => decline ? refuse() : post("/qa/sign-transaction", { json: await transaction.toJSON() }) },
    },
  };
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: (api) => api.register(w) }));
  return address;
})()`;

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, ORIGIN);
  if (pathname === "/qa/wallet.js") return send(res, walletScript(), "text/javascript");
  if (pathname === "/qa/sign-message" && req.method === "POST") {
    const { message } = await body(req);
    const { bytes, signature } = await wallet.signPersonalMessage(new Uint8Array(message));
    return send(res, { bytes, signature });
  }
  if (pathname === "/qa/sign-transaction" && req.method === "POST") {
    const tx = Transaction.from((await body(req)).json);
    tx.setGasPrice(1000);
    tx.setGasBudget(5_000_000 + Math.floor(Math.random() * 1e6));
    tx.setGasPayment([GAS_COIN]);
    const bytes = await tx.build();
    const { signature } = await wallet.signTransaction(bytes);
    return send(res, { bytes: toBase64(bytes), signature });
  }
  return handleApi(req, res);
}).listen(PORT, "127.0.0.1", () => console.log(`QA harness on ${ORIGIN}/app (test wallet ${wallet.toSuiAddress()})`));
