// Builds Edith's request handler from the environment. With DATABASE_URL (Neon on Vercel), every piece of
// state is in Postgres and any number of instances can serve it; without it (local runs), wallet records and
// the replay ledger are files and pending approvals live in this one process.
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createHandler } from "./api.mjs";
import { createAuth } from "./auth.mjs";
import { createMemory } from "./memory.mjs";
import { createProviderFetch, isLocalOrigin } from "./net.mjs";
import { createProvider } from "./server.mjs";
import { migrate, pgDb, pgLedger, pgLimiter, pgNonces, pgPlans, pgStore } from "./state.mjs";
import { createStore } from "./store.mjs";
import { NETWORK, tatumSuiClient } from "./sui.mjs";

const REQUIRED = ["SESSION_SECRET", "SERVER_CHALLENGE_SECRET", "TATUM_API_KEY", "MEMWAL_PRIVATE_KEY", "MEMWAL_ACCOUNT_ID", "SERVER_SUI_ADDRESS", "SUI_NETWORK"];

export async function buildHandler(env = process.env, { port } = {}) {
  const origin = (env.PUBLIC_ORIGIN ?? `http://localhost:${port ?? 4030}`).replace(/\/+$/, "");
  const secure = origin.startsWith("https://");
  // A public deployment refuses to start half-configured. Serverless instances share nothing but the
  // database and these secrets, so they must all be set explicitly.
  const serverless = Boolean(env.VERCEL);
  const missing = secure || serverless ? REQUIRED.filter((name) => !env[name]) : [];
  if (serverless && !env.DATABASE_URL) missing.push("DATABASE_URL");
  if (secure && !serverless && !env.DATABASE_URL && !env.DATA_DIR) missing.push("DATABASE_URL or DATA_DIR");
  if (serverless && !secure) missing.push("PUBLIC_ORIGIN (https)");
  if (missing.length) throw new Error(`Edith is not configured for this deployment. Set: ${missing.join(", ")}`);
  const allowPrivate = env.ALLOW_PRIVATE_PROVIDERS === "1";
  if (allowPrivate && (serverless || secure || env.NODE_ENV === "production" || !isLocalOrigin(origin))) {
    throw new Error("ALLOW_PRIVATE_PROVIDERS is only permitted for local development, never a public deployment.");
  }

  const sui = tatumSuiClient();
  let durable = {};
  if (env.DATABASE_URL) {
    const db = pgDb(new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 }));
    await migrate(db);
    durable = {
      store: pgStore(db),
      plans: pgPlans(db),
      limiter: (name, options) => pgLimiter(db, name, options),
      spendNonce: pgNonces(db),
      ledger: pgLedger(db),
    };
  }

  const provider = await createProvider({ env, prefix: "/demo", ledger: durable.ledger });
  // Without SESSION_SECRET (local only), sessions end when the process restarts.
  const secret = env.SESSION_SECRET || randomBytes(32).toString("hex");
  return createHandler({
    sui, network: NETWORK, secure, origin,
    memory: createMemory(env),
    store: durable.store ?? createStore(`${env.DATA_DIR ?? "data"}/users`),
    plans: durable.plans,
    limiter: durable.limiter,
    auth: createAuth({ secret, origin, network: NETWORK, client: sui, spendNonce: durable.spendNonce }),
    // The demo provider is reached at its public address; locally it is mapped straight to this process.
    providerFetch: createProviderFetch({
      demo: { origin, prefix: "/demo", target: serverless ? origin : `http://127.0.0.1:${port ?? 4030}` },
      allowPrivate,
    }),
    demo: { ...provider, name: "Quote Desk", baseUrl: `${origin}/demo/quote`, priceMist: provider.price },
    staticDir: env.STATIC_DIR ?? "web/dist",
    trustProxy: serverless || env.TRUST_PROXY === "1",
  });
}
