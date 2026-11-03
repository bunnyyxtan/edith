// HTTP API behind the web app. Everything except config and sign-in acts for the signed-in wallet only,
// on that wallet's own memory, limits and activity. Long operations stream NDJSON step events, so the
// app shows real progress rather than a spinner.
//   GET  /api/config                  network, the demo provider, limit ceilings
//   GET  /api/session                 the signed-in address, or null
//   POST /api/session/challenge       a sign-in message for the wallet to sign
//   POST /api/session                 sign in with that signed message
//   POST /api/session/end             sign out
//   GET  /api/me                      limits, 24-hour spend and activity
//   GET  /api/balance                 the wallet's SUI balance
//   PUT  /api/limits                  change spending limits
//   GET  /api/memory?url=             what Edith remembers about an endpoint, read back from Walrus Memory
//   POST /api/requests                recall, judge and quote. Nothing is paid.          (stream)
//   POST /api/requests/:id/pay        settle the transfer the wallet signed               (stream)
//   POST /api/requests/:id/cancel     decline a quote
//   POST /api/requests/:id/recheck    look again at a payment whose fate was unknown
//   POST /api/requests/:id/requote    a fresh price for an agent's request still waiting for approval
//   GET  /api/agents                  the wallet's agents
//   POST /api/agents                  connect an agent: returns its key once
//   POST /api/agents/:id/revoke       disconnect an agent
// Agent API, authorized by an agent key (Authorization: Bearer ek_...), never by the session cookie:
//   POST /v1/requests                 ask Edith about a paid URL. Refusals are final; payments wait for the owner.
//   GET  /v1/requests/:id             where that request stands, and the provider's answer once paid
//   POST /v1/requests/:id/cancel      withdraw a request still waiting for approval
// /demo/* is the bundled paid API; everything else serves the built web app.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fromBase64 } from "@mysten/sui/utils";
import { MAX_AGENTS, matchAgent, newAgent, parseAgentToken, publicAgent, validAgentName } from "./agents.mjs";
import { AuthError, SESSION_COOKIE, SESSION_TTL_MS } from "./auth.mjs";
import { MAX_PRICE_MIST, SettleError, createEdith } from "./edith.mjs";
import { describeRequest, loadRecords, toOutcome, userNamespace } from "./memory.mjs";
import { UnsafeUrlError } from "./net.mjs";
import { PaymentError, transactionDigest } from "./payment.mjs";
import { newActivityId, spentToday, withActivity } from "./store.mjs";
import { withRetry } from "./sui.mjs";
import { HttpError, cookieHeader, createLimiter, openStream, readCookie, readJson, securityHeaders, send, serveStatic } from "./http.mjs";

const PLAN_TTL_MS = 4 * 60_000; // inside the provider's 5-minute challenge window
const APPROVAL_WINDOW_MS = 24 * 60 * 60_000; // how long an agent's request waits for its owner
export const MAX_DAILY_MIST = 1_000_000_000n; // 1 SUI: the highest daily limit a person can set
const BODY_PREVIEW_CHARS = 2000;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const words = (token) => (token ? String(token).replaceAll("_", " ") : null);
const preview = (body) => (body === null || body === undefined ? null : JSON.stringify(body, null, 2).slice(0, BODY_PREVIEW_CHARS));
const bigLimits = (limits) => ({ perCallMist: BigInt(limits.perCallMist), dailyMist: BigInt(limits.dailyMist) });

function requestUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new HttpError(400, "Enter a full address, starting with https://.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new HttpError(400, "Only http:// and https:// addresses are supported.");
  if (url.username || url.password) throw new HttpError(400, "Addresses with a username or password aren't supported.");
  return url.href;
}

// A memory record in the shape the app reads.
export function present(record) {
  const outcome = toOutcome(record);
  const request = words(record.key);
  if (record.event === "avoided") {
    return { event: "declined", request, reason: words(record.reason), savedMist: record.saved ?? "0", at: record.at, blobId: record.blobId ?? null };
  }
  if (!outcome) return null;
  return {
    event: "paid", result: outcome.result, kind: outcome.kind ?? null, request, reason: words(outcome.reason),
    paidMist: String(outcome.paid), digest: outcome.digest ?? null, at: outcome.at, blobId: record.blobId ?? null,
  };
}

// Why Edith decided, with the remembered outcome behind it when memory decided.
function presentDecision(decision) {
  const basis = decision.basis;
  return {
    action: decision.action, source: decision.source ?? "memory", reason: words(decision.reason),
    basis: basis ? { result: basis.result, reason: words(basis.reason), digest: basis.digest ?? null, at: basis.at, blobId: basis.blobId ?? null, paidMist: String(basis.paid ?? 0) } : null,
  };
}

// What a person should read when something goes wrong. Internal details stay in the server log.
function describeFailure(err) {
  if (err instanceof PaymentError) return `This provider's payment terms aren't safe to pay: ${err.message}. Nothing was paid.`;
  if (err instanceof HttpError || err instanceof UnsafeUrlError || err instanceof SettleError) return err.message;
  if (err?.name === "TimeoutError") return "The provider took too long to answer. Nothing was paid.";
  if (["ECONNREFUSED", "ENOTFOUND", "ECONNRESET"].includes(err?.cause?.code)) return "Edith couldn't reach this provider. Check the address, or try again once it's online. Nothing was paid.";
  return "Edith couldn't prepare this request. Nothing was paid.";
}

// Item fields for each way a plan can end.
function plannedItem(planned, base) {
  const decision = presentDecision(planned.decision ?? { action: planned.action });
  if (planned.action === "pay") {
    const { payTo, amount } = planned.terms;
    return { ...base, state: "awaiting", decision, amountMist: String(amount), terms: { payTo, amount: String(amount) }, expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString() };
  }
  if (planned.action === "skip") {
    const quoted = planned.terms?.amount;
    return { ...base, state: "blocked", decision, amountMist: quoted !== undefined ? String(quoted) : decision.basis?.paidMist ?? null, amountFrom: quoted !== undefined ? "quote" : "memory" };
  }
  return { ...base, state: "free", status: planned.status, body: preview(planned.body) };
}

// Where a failed settlement leaves the activity item.
function failedItem(err, sent) {
  if (err instanceof SettleError) {
    const state = { check: "failed", refused: "refused", uncertain: "uncertain", remember: "paid" }[err.stage] ?? (sent ? "uncertain" : "failed");
    return { state, error: err.message, ...(err.stage === "remember" ? { memory: "failed" } : {}) };
  }
  return sent
    ? { state: "uncertain", error: "Something interrupted the payment after it was sent. Edith will check Sui before anything else happens." }
    : { state: "failed", error: "Something interrupted the payment before it was sent. Nothing was paid." };
}

export function createApi({ sui, memory, network, store, auth, providerFetch, demo, staticDir, origin = "", secure = false, trustProxy = false }) {
  const plans = new Map(); // activity id -> { planned, address, state, expires }
  // ponytail: plans live in memory on one instance; a restart drops live quotes (agent requests re-quote on review).
  const signInLimit = createLimiter({ limit: 20, windowMs: 60_000 });
  const requestLimit = createLimiter({ limit: 30, windowMs: 60_000 });

  const edithFor = (address) => createEdith({ sui, memory, network, payer: address, namespace: userNamespace(address), fetch: providerFetch });
  const clientIp = (req) => (trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress;

  function signedIn(req) {
    const address = auth.session(readCookie(req, SESSION_COOKIE));
    if (!address) throw new HttpError(401, "Connect your wallet to continue.");
    return address;
  }

  const setItem = (address, id, fields) => store.update(address, (user) => withActivity(user, id, fields)).then((u) => u.activity.find((a) => a.id === id));

  // Quotes that outlived their window are shown as expired, and a settlement no longer in progress
  // (the server restarted mid-payment) as uncertain, whatever the file last said.
  // An agent's request outlives its 4-minute quote: it waits for the owner, and a fresh price is fetched on review.
  function current(item) {
    if (item.state === "awaiting" && !(plans.get(item.id)?.expires > Date.now())) {
      const waiting = item.source?.kind === "agent" && Date.now() - Date.parse(item.at) < APPROVAL_WINDOW_MS;
      return waiting ? { ...item, stale: true } : { ...item, state: "expired" };
    }
    if (item.state === "settling" && !plans.has(item.id)) {
      return { ...item, state: "uncertain", error: "Edith was interrupted while this payment settled. Check Sui to see whether it went through." };
    }
    return item;
  }

  // Recall, judge and quote one request for `address`, and record it as activity `id`. Nothing is paid.
  async function planRequest(address, target, { source, emit = () => {}, id = newActivityId(), at = new Date().toISOString() }) {
    const user = await store.read(address);
    const planned = await edithFor(address).plan(target, { limits: bigLimits(user.limits), spentMist: spentToday(user) }, emit);
    const base = { at, url: target, request: words(planned.context.key), provider: planned.context.provider, context: planned.context, source, stale: false };
    const item = plannedItem(planned, base);
    if (planned.action === "pay") {
      for (const [key, entry] of plans) if (entry.state === "ready" && entry.expires < Date.now()) plans.delete(key);
      plans.set(id, { planned, address, state: "ready", expires: Date.parse(item.expiresAt) });
    }
    return setItem(address, id, item);
  }

  const logPlanFailure = (err) => {
    if (!(err instanceof PaymentError || err instanceof UnsafeUrlError || err instanceof HttpError)) console.error("plan failed:", err);
  };

  async function startRequest(req, res, address) {
    const target = requestUrl((await readJson(req)).url);
    if (!requestLimit(address)) throw new HttpError(429, "That's a lot of requests in a minute. Wait a moment, then try again.");
    const id = newActivityId();
    const emit = openStream(res);
    emit({ step: "started", id });
    try {
      emit({ step: "planned", activity: await planRequest(address, target, { source: { kind: "app" }, emit, id }) });
    } catch (err) {
      logPlanFailure(err);
      emit({ step: "error", message: describeFailure(err) });
    }
    res.end();
  }

  // A fresh price for an agent's request that waited past its quote. Memory and limits are checked again.
  async function requote(address, id) {
    const item = (await store.read(address)).activity.find((a) => a.id === id);
    if (!item) throw new HttpError(404, "Edith has no record of this request.");
    const now = current(item);
    if (now.state !== "awaiting") return { activity: now };
    if (!now.stale) return { activity: now };
    try {
      return { activity: await planRequest(address, item.url, { source: item.source, id, at: item.at }) };
    } catch (err) {
      logPlanFailure(err);
      throw new HttpError(502, describeFailure(err));
    }
  }

  async function agentFor(req) {
    const token = parseAgentToken(req.headers.authorization);
    const agent = token && matchAgent(await store.read(token.address), token.id, token.secret);
    if (!agent) throw new HttpError(401, "This agent key is invalid or has been disconnected.");
    store.update(token.address, (u) => ({ ...u, agents: u.agents.map((a) => (a.id === agent.id ? { ...a, lastUsedAt: new Date().toISOString() } : a)) }))
      .catch((err) => console.error("agent write failed:", err));
    return { address: token.address, agent };
  }

  // What an agent sees of its own request: the decision, why, and the provider's answer once paid.
  function agentView(item) {
    const now = current(item);
    return {
      id: now.id, state: now.state, url: now.url, provider: now.provider, amountMist: now.amountMist ?? null,
      decision: now.decision ? { action: now.decision.action, source: now.decision.source, reason: now.decision.reason } : null,
      approval: now.state === "awaiting" ? { needed: true, review: `${origin}/app?review=${now.id}` } : null,
      result: now.result ?? null, problem: now.problem ?? null, status: now.status ?? null, body: now.body ?? null,
      digest: now.digest ?? null, blobId: now.blobId ?? null, error: now.error ?? null, at: now.at,
    };
  }

  async function ownedByAgent(address, agent, id) {
    const item = (await store.read(address)).activity.find((a) => a.id === id && a.source?.agentId === agent.id);
    if (!item) throw new HttpError(404, "This agent has no request with that id.");
    return item;
  }

  function takePlan(address, id) {
    const entry = plans.get(id);
    if (!entry || entry.address !== address) throw new HttpError(404, "This quote is no longer available. Ask Edith again for a fresh one.");
    if (entry.expires < Date.now()) {
      plans.delete(id);
      throw new HttpError(410, "This quote expired before it was signed. Nothing was paid. Ask Edith again for a fresh one.");
    }
    if (entry.state !== "ready") throw new HttpError(409, "This payment is already being processed.");
    entry.state = "paying"; // set before any await, so a double submit cannot settle twice
    return entry;
  }

  // Counts this payment against the limits and marks it settling, in one write.
  function reserve(address, id, amount, digest) {
    return store.update(address, (user) => {
      const limits = bigLimits(user.limits);
      if (amount > limits.perCallMist) throw new HttpError(409, "This payment is over your limit per payment now. Nothing was paid.");
      if (spentToday(user) + amount > limits.dailyMist) throw new HttpError(409, "This payment would take you past your 24-hour limit. Nothing was paid.");
      return withActivity(user, id, { state: "settling", digest });
    });
  }

  async function pay(req, res, address, id) {
    const { transaction, signature } = await readJson(req);
    if (typeof transaction !== "string" || !BASE64_RE.test(transaction) || typeof signature !== "string" || !BASE64_RE.test(signature)) {
      throw new HttpError(400, "Your wallet didn't return a signed payment.");
    }
    const entry = takePlan(address, id);
    let digest;
    try {
      digest = transactionDigest(fromBase64(transaction));
      await reserve(address, id, entry.planned.terms.amount, digest);
    } catch (err) {
      entry.state = "ready";
      throw err instanceof HttpError ? err : new HttpError(400, "Your wallet returned a payment Edith couldn't read. Nothing was paid.");
    }

    const emit = openStream(res);
    let sent = false;
    const track = (event) => {
      if (event.step === "paying") sent = true;
      if (event.step === "verified") {
        setItem(address, id, { state: "paid", memory: "saving", verifiedAt: new Date(event.timestampMs ?? Date.now()).toISOString() }).catch((err) => console.error("activity write failed:", err));
      }
      emit(event);
    };
    try {
      const settled = await edithFor(address).settle(entry.planned, { transaction, signature }, track);
      const item = await setItem(address, id, { state: "paid", result: settled.result, problem: settled.problem, status: settled.status, body: preview(settled.body), blobId: settled.blobId, memory: "saved", error: null });
      emit({ step: "settled", activity: item });
    } catch (err) {
      console.error("settle failed:", err);
      const item = await setItem(address, id, failedItem(err, sent));
      emit({ step: "error", message: item.error, activity: item });
    } finally {
      plans.delete(id);
    }
    res.end();
  }

  async function recheck(address, id) {
    const item = (await store.read(address)).activity.find((a) => a.id === id);
    if (!item) throw new HttpError(404, "Edith has no record of this payment.");
    if (current(item).state !== "uncertain") return { activity: current(item) };
    const terms = { payTo: item.terms.payTo, amount: BigInt(item.terms.amount) };
    const result = await edithFor(address).reconcile({ context: item.context, terms, digest: item.digest });
    if (!result.paid) return { activity: current(await setItem(address, id, { state: "uncertain", checkedAt: new Date().toISOString() })) };
    return { activity: await setItem(address, id, { state: "paid", result: "failure", problem: result.problem, blobId: result.blobId, memory: "saved", error: null, verifiedAt: new Date(result.verification.timestampMs ?? Date.now()).toISOString() }) };
  }

  function validLimits(body) {
    const parse = (value) => (/^[1-9]\d{0,12}$/.test(String(value)) ? BigInt(value) : null);
    const perCallMist = parse(body.perCallMist);
    const dailyMist = parse(body.dailyMist);
    if (perCallMist === null || perCallMist > MAX_PRICE_MIST) throw new HttpError(400, `The limit per payment must be between 0.000000001 and ${Number(MAX_PRICE_MIST) / 1e9} SUI.`);
    if (dailyMist === null || dailyMist > MAX_DAILY_MIST) throw new HttpError(400, `The 24-hour limit can be at most ${Number(MAX_DAILY_MIST) / 1e9} SUI.`);
    if (dailyMist < perCallMist) throw new HttpError(400, "The 24-hour limit can't be lower than the limit per payment.");
    return { perCallMist: String(perCallMist), dailyMist: String(dailyMist) };
  }

  async function memoryFor(address, url) {
    const { endpoint, provider } = describeRequest("GET", url);
    const records = (await loadRecords(memory, { endpoint, provider, network }, userNamespace(address))).map(present).filter(Boolean);
    records.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { endpoint: words(endpoint), provider, records };
  }

  const routes = {
    "GET /api/config": async () => ({ network, maxPriceMist: MAX_PRICE_MIST, maxDailyMist: MAX_DAILY_MIST, demo: { name: demo.name, baseUrl: demo.baseUrl, priceMist: demo.priceMist, payTo: demo.payTo } }),

    "GET /api/session": async (req) => ({ address: auth.session(readCookie(req, SESSION_COOKIE)) }),

    "POST /api/session/challenge": async (req) => {
      if (!signInLimit(clientIp(req))) throw new HttpError(429, "Too many sign-in attempts. Wait a minute, then try again.");
      return { message: auth.signInMessage((await readJson(req)).address) };
    },

    "POST /api/session": async (req, res) => {
      if (!signInLimit(clientIp(req))) throw new HttpError(429, "Too many sign-in attempts. Wait a minute, then try again.");
      const { message, signature } = await readJson(req);
      const { address, cookie } = await auth.signIn(message, signature);
      send(res, 200, { address }, { "set-cookie": cookieHeader(SESSION_COOKIE, cookie, { maxAgeMs: SESSION_TTL_MS, secure }) });
    },

    "POST /api/session/end": async (req, res) => {
      await readJson(req);
      send(res, 200, { address: null }, { "set-cookie": cookieHeader(SESSION_COOKIE, "", { maxAgeMs: 0, secure }) });
    },

    "GET /api/me": async (req) => {
      const address = signedIn(req);
      const user = await store.read(address);
      return { address, limits: user.limits, limitsSetAt: user.limitsSetAt ?? null, spentMist: spentToday(user), activity: user.activity.map(current), agents: (user.agents ?? []).map(publicAgent) };
    },

    "GET /api/balance": async (req) => {
      const owner = signedIn(req);
      const { balance } = await withRetry(() => sui.core.getBalance({ owner }));
      return { mist: balance.balance };
    },

    "PUT /api/limits": async (req) => {
      const address = signedIn(req);
      const limits = validLimits(await readJson(req));
      const user = await store.update(address, (u) => ({ ...u, limits, limitsSetAt: new Date().toISOString() }));
      return { limits: user.limits, limitsSetAt: user.limitsSetAt, spentMist: spentToday(user) };
    },

    "GET /api/memory": async (req, res, url) => memoryFor(signedIn(req), requestUrl(url.searchParams.get("url"))),

    "POST /api/requests": async (req, res) => startRequest(req, res, signedIn(req)),

    "POST /api/requests/:id/pay": async (req, res, url, id) => pay(req, res, signedIn(req), id),

    "POST /api/requests/:id/cancel": async (req, res, url, id) => {
      const address = signedIn(req);
      await readJson(req);
      const entry = plans.get(id);
      if (entry?.address === address && entry.state === "ready") plans.delete(id);
      const item = (await store.read(address)).activity.find((a) => a.id === id);
      if (!item) throw new HttpError(404, "Edith has no record of this request.");
      return { activity: item.state === "awaiting" ? await setItem(address, id, { state: "cancelled" }) : current(item) };
    },

    "POST /api/requests/:id/recheck": async (req, res, url, id) => {
      const address = signedIn(req);
      await readJson(req);
      return recheck(address, id);
    },

    "POST /api/requests/:id/requote": async (req, res, url, id) => {
      const address = signedIn(req);
      await readJson(req);
      return requote(address, id);
    },

    "GET /api/agents": async (req) => {
      const user = await store.read(signedIn(req));
      return { agents: (user.agents ?? []).map(publicAgent) };
    },

    "POST /api/agents": async (req) => {
      const address = signedIn(req);
      const name = validAgentName((await readJson(req)).name);
      if (!name) throw new HttpError(400, "Give the agent a name of up to 40 letters, numbers or spaces.");
      const { agent, token } = newAgent(address, name);
      await store.update(address, (u) => {
        const live = (u.agents ?? []).filter((a) => !a.revokedAt);
        if (live.length >= MAX_AGENTS) throw new HttpError(409, `You can connect up to ${MAX_AGENTS} agents. Disconnect one first.`);
        return { ...u, agents: [...(u.agents ?? []), agent] };
      });
      return { agent: publicAgent(agent), token };
    },

    "POST /api/agents/:id/revoke": async (req, res, url, id) => {
      const address = signedIn(req);
      await readJson(req);
      const user = await store.update(address, (u) => {
        if (!(u.agents ?? []).some((a) => a.id === id)) throw new HttpError(404, "This wallet has no agent with that id.");
        return { ...u, agents: u.agents.map((a) => (a.id === id && !a.revokedAt ? { ...a, revokedAt: new Date().toISOString() } : a)) };
      });
      return { agent: publicAgent(user.agents.find((a) => a.id === id)) };
    },

    "POST /v1/requests": async (req) => {
      const { address, agent } = await agentFor(req);
      const target = requestUrl((await readJson(req)).url);
      if (!requestLimit(address)) throw new HttpError(429, "Too many requests in a minute. Wait a moment, then try again.");
      try {
        return agentView(await planRequest(address, target, { source: { kind: "agent", agentId: agent.id, name: agent.name } }));
      } catch (err) {
        logPlanFailure(err);
        throw new HttpError(422, describeFailure(err));
      }
    },

    "GET /v1/requests/:id": async (req, res, url, id) => {
      const { address, agent } = await agentFor(req);
      return agentView(await ownedByAgent(address, agent, id));
    },

    "POST /v1/requests/:id/cancel": async (req, res, url, id) => {
      const { address, agent } = await agentFor(req);
      await readJson(req);
      const item = await ownedByAgent(address, agent, id);
      if (item.state !== "awaiting") return agentView(item);
      if (plans.get(id)?.state === "paying") throw new HttpError(409, "The owner is already paying this request.");
      plans.delete(id);
      return agentView(await setItem(address, id, { state: "cancelled", error: "Withdrawn by the agent." }));
    },
  };

  function route(method, pathname) {
    const action = /^\/(api|v1)\/(requests|agents)\/([\w-]{6,32})(?:\/(pay|cancel|recheck|requote|revoke))?$/.exec(pathname);
    if (action) {
      const [, scope, kind, id, verb] = action;
      return [routes[`${method} /${scope}/${kind}/:id${verb ? `/${verb}` : ""}`] ?? null, id];
    }
    return [routes[`${method} ${pathname}`], null];
  }

  return createServer(async (req, res) => {
    securityHeaders(res, secure);
    const url = new URL(req.url, "http://edith");
    if (demo.handler && (url.pathname === "/demo" || url.pathname.startsWith("/demo/"))) return demo.handler(req, res);
    if (!url.pathname.startsWith("/api/") && !url.pathname.startsWith("/v1/")) return serveStatic(res, staticDir, url.pathname);
    const [handler, id] = route(req.method, url.pathname);
    if (!handler) return send(res, 404, { error: "Not found." });
    try {
      const result = await handler(req, res, url, id);
      if (result !== undefined) send(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      if (err instanceof AuthError) return send(res, 401, { error: err.message });
      if (err instanceof UnsafeUrlError) return send(res, 400, { error: err.message });
      console.error(`${req.method} ${url.pathname} failed:`, err);
      send(res, 502, { error: "Edith couldn't load this right now. Try again in a moment." });
    }
  });
}

if (import.meta.main) {
  const { tatumSuiClient, NETWORK } = await import("./sui.mjs");
  const { createMemory } = await import("./memory.mjs");
  const { createAuth } = await import("./auth.mjs");
  const { createStore } = await import("./store.mjs");
  const { createProviderFetch } = await import("./net.mjs");
  const { createProvider } = await import("./server.mjs");

  const env = process.env;
  const port = Number(env.PORT ?? 4030);
  const origin = (env.PUBLIC_ORIGIN ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const secure = origin.startsWith("https://");
  if (secure && !env.SESSION_SECRET) throw new Error("SESSION_SECRET is required when PUBLIC_ORIGIN is https");
  // Without SESSION_SECRET (local only), sessions end when the server restarts.
  const secret = env.SESSION_SECRET || randomBytes(32).toString("hex");

  const sui = tatumSuiClient();
  const provider = await createProvider({ prefix: "/demo" });
  createApi({
    sui, network: NETWORK, secure, origin,
    memory: createMemory(),
    store: createStore(env.DATA_DIR ? `${env.DATA_DIR}/users` : "data/users"),
    auth: createAuth({ secret, origin, network: NETWORK, client: sui }),
    providerFetch: createProviderFetch({ demo: { origin, prefix: "/demo", target: `http://127.0.0.1:${port}` }, allowPrivate: env.ALLOW_PRIVATE_PROVIDERS === "1" }),
    demo: { ...provider, name: "Quote Desk", baseUrl: `${origin}/demo/quote`, priceMist: provider.price },
    staticDir: env.STATIC_DIR ?? "web/dist",
    trustProxy: env.TRUST_PROXY === "1",
  }).listen(port, env.HOST ?? "127.0.0.1", () => console.log(`Edith on ${origin} (network ${NETWORK}, listening on ${env.HOST ?? "127.0.0.1"}:${port})`));
}
