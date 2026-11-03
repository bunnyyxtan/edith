// The web app's API end to end: wallet sign-in, per-wallet isolation, limits, and the full
// quote -> sign -> settle -> remember -> decline journey over the real paywall and a fake chain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { MemWalMock } from "@mysten-incubation/memwal";
import { createApi, present } from "../src/api.mjs";
import { createAuth } from "../src/auth.mjs";
import { createProviderFetch } from "../src/net.mjs";
import { createLedger, createPaywall } from "../src/paywall.mjs";
import { createProviderHandler } from "../src/server.mjs";
import { createStore, withActivity } from "../src/store.mjs";
import { settlePayment } from "../src/sui.mjs";
import { fakeChain, signedTransfer } from "./chain.mjs";

const PAY_TO = `0x${"d".repeat(64)}`;
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

async function start(t, { staticDir, providerFetch = createProviderFetch({ allowPrivate: true }) } = {}) {
  const chain = fakeChain();
  const paywall = createPaywall({
    secret: "p", network: "mainnet", payTo: PAY_TO, price: 1_000_000n,
    ledger: createLedger(join(tmp("edith-"), "used.txt")),
    settlePayment: (payment, terms) => settlePayment(chain.client, payment, terms),
  });
  const demo = { name: "Quote Desk", baseUrl: null, priceMist: 1_000_000n, payTo: PAY_TO, handler: createProviderHandler(paywall, "/demo") };
  const store = createStore(tmp("edith-users-"));
  const server = createApi({
    sui: chain.client, network: "mainnet", memory: new MemWalMock({ namespace: "edith" }),
    store,
    auth: createAuth({ secret: "s", origin: "http://edith.test", network: "mainnet", client: chain.client }),
    providerFetch,
    demo, staticDir, origin: "http://edith.test",
  }).listen(0);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  demo.baseUrl = `${base}/demo/quote`;

  const call = (method, path, { body, cookie, headers = {} } = {}) => fetch(base + path, {
    method,
    headers: { ...(body !== undefined || method !== "GET" ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  const events = async (res) => (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
  const agentCall = (token, method, path, body) => fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });

  // A person with their own wallet, signed in.
  async function person(keypair = new Ed25519Keypair()) {
    const address = keypair.toSuiAddress();
    const { message } = await (await call("POST", "/api/session/challenge", { body: { address } })).json();
    const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(message));
    const res = await call("POST", "/api/session", { body: { message, signature } });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie").split(";")[0];
    const as = (method, path, body) => call(method, path, { body, cookie });
    const ask = async (ticker) => (await events(await as("POST", "/api/requests", { url: `${demo.baseUrl}?ticker=${ticker}` }))).at(-1);
    // What the wallet does when its owner approves a quote.
    const sign = async (activity, overrides = {}) => {
      const t2 = await signedTransfer({ payer: keypair, payTo: activity.terms.payTo, amount: activity.terms.amount, ...overrides });
      chain.register(t2);
      return { transaction: t2.transaction, signature: t2.signature, digest: t2.digest };
    };
    const pay = async (activity, signed) => as("POST", `/api/requests/${activity.id}/pay`, signed ?? (await sign(activity)));
    // An agent this person connected, calling the agent API with its key and nothing else.
    const connectAgent = async (name = "Research bot") => {
      const res = await as("POST", "/api/agents", { name });
      assert.equal(res.status, 200);
      const { agent, token } = await res.json();
      return { agent, token, call: (method, path, body) => agentCall(token, method, path, body) };
    };
    return { keypair, address, cookie, as, ask, sign, pay, message, signature, connectAgent };
  }

  return { base, call, events, person, chain, demo, store };
}

test("activity eviction cannot reset the API daily limit or approve a previously quoted payment", async (t) => {
  const { person, store, events } = await start(t);
  const alice = await person();
  await alice.as("PUT", "/api/limits", { perCallMist: "1000000", dailyMist: "1000000" });
  const first = (await alice.ask("SUI")).activity;
  const second = (await alice.ask("WAL")).activity;
  assert.equal((await events(await alice.pay(first))).at(-1).activity.state, "paid");
  await store.update(alice.address, (user) => {
    for (let i = 0; i < 210; i++) user = withActivity(user, `free-${i}`, { at: new Date(Date.now() + i + 1).toISOString(), state: "free" });
    return user;
  });
  const me = await (await alice.as("GET", "/api/me")).json();
  assert.equal(me.activity.some((a) => a.id === first.id), false);
  assert.equal(me.spentMist, "1000000");
  assert.equal((await alice.ask("BTC")).activity.state, "blocked");
  assert.equal((await alice.pay(second)).status, 409, "settlement rechecks the durable ledger");
});

test("an evicted awaiting quote still reserves its full amount when signed", async (t) => {
  const { person, store, events } = await start(t);
  const alice = await person();
  const item = (await alice.ask("SUI")).activity;
  await store.update(alice.address, (user) => {
    for (let i = 0; i < 210; i++) user = withActivity(user, `free-${i}`, { at: new Date(Date.now() - 1).toISOString(), state: "free" });
    // Force the old quote out of display history, as an agent flood would do.
    return { ...user, activity: user.activity.filter((a) => a.id !== item.id) };
  });
  const result = (await events(await alice.pay(item))).at(-1);
  assert.equal(result.activity.state, "paid");
  assert.equal(result.activity.amountMist, "1000000");
  assert.equal((await (await alice.as("GET", "/api/me")).json()).spentMist, "1000000");
});

test("provider refusal stays uncertain through activity churn and can be reconciled after late settlement", async (t) => {
  const network = createProviderFetch({ allowPrivate: true });
  const { person, chain, events, store } = await start(t, {
    providerFetch: (url, init) => init?.headers?.["x-payment"]
      ? new Response('{"error":"refused"}', { status: 403 }) : network(url, init),
  });
  const alice = await person();
  await alice.as("PUT", "/api/limits", { perCallMist: "1000000", dailyMist: "1000000" });
  const item = (await alice.ask("SUI")).activity;
  const signed = await alice.sign(item);
  const result = (await events(await alice.pay(item, signed))).at(-1);
  assert.equal(result.activity.state, "uncertain");
  assert.doesNotMatch(result.message, /Nothing was paid/);
  await store.update(alice.address, (user) => {
    for (let i = 0; i < 210; i++) user = withActivity(user, `free-${i}`, { at: new Date(Date.now() + i).toISOString(), state: "free" });
    return user;
  });
  const me = await (await alice.as("GET", "/api/me")).json();
  assert.equal(me.spentMist, "1000000");
  assert.ok(me.activity.some((a) => a.id === item.id), "the existing recheck UI remains available");
  assert.equal((await alice.ask("WAL")).activity.state, "blocked");
  chain.land(signed.digest);
  const reconciled = await (await alice.as("POST", `/api/requests/${item.id}/recheck`)).json();
  assert.equal(reconciled.activity.state, "paid");
  assert.equal((await (await alice.as("GET", "/api/me")).json()).spentMist, "1000000");
});

test("a finalized chain failure releases an uncertain API reservation", async (t) => {
  const network = createProviderFetch({ allowPrivate: true });
  const { person, chain, events } = await start(t, {
    providerFetch: (url, init) => init?.headers?.["x-payment"] ? new Response("{}", { status: 400 }) : network(url, init),
  });
  const alice = await person();
  const item = (await alice.ask("SUI")).activity;
  const signed = await alice.sign(item);
  assert.equal((await events(await alice.pay(item, signed))).at(-1).activity.state, "uncertain");
  chain.overrides[signed.digest] = { success: false };
  chain.land(signed.digest);
  const result = await (await alice.as("POST", `/api/requests/${item.id}/recheck`)).json();
  assert.equal(result.activity.state, "refused");
  assert.equal(result.activity.chainFailed, true);
  assert.equal((await (await alice.as("GET", "/api/me")).json()).spentMist, "0");
});

test("both app and agent requests reject public HTTP providers", async (t) => {
  const { person, events, chain } = await start(t);
  const alice = await person();
  const result = (await events(await alice.as("POST", "/api/requests", { url: "http://8.8.8.8/quote" }))).at(-1);
  assert.equal(result.step, "error");
  assert.match(result.message, /HTTPS/);
  const bot = await alice.connectAgent();
  const rejected = await bot.call("POST", "/v1/requests", { url: "http://8.8.8.8/quote" });
  assert.equal(rejected.status, 422);
  assert.match((await rejected.json()).error, /HTTPS/);
  assert.equal(chain.calls.execute, 0);
});

test("legacy history holds new payments and old quotes without blocking free requests or fabricating history", async (t) => {
  const transport = createProviderFetch({ allowPrivate: true });
  const { person, store, chain, demo, events } = await start(t, {
    providerFetch: (url, init) => String(url).endsWith("FREE") ? new Response('{"free":true}') : transport(url, init),
  });
  const alice = await person();
  const quote = (await alice.ask("SUI")).activity;
  await store.update(alice.address, (user) => {
    const { paymentHistory, ...legacy } = user;
    return legacy;
  });
  assert.match((await alice.ask("WAL")).message, /historical payments/);
  const rejected = await alice.pay(quote);
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).error, /historical payments/);
  const bot = await alice.connectAgent();
  assert.equal((await bot.call("POST", "/v1/requests", { url: `${demo.baseUrl}?ticker=BTC` })).status, 422);
  await alice.as("PUT", "/api/limits", { perCallMist: "1000000", dailyMist: "2000000", paymentHistory: { version: 1, basis: "created-with-guards" } });
  assert.equal((await alice.ask("FREE")).activity.state, "free");
  assert.equal((await store.read(alice.address)).paymentHistory, undefined, "ordinary writes never certify legacy history");
  assert.equal(chain.calls.execute, 0);
  // Fixture for an operator-reviewed empty history, not an automated migration.
  await store.update(alice.address, (user) => ({ ...user, paymentHistory: {
    version: 1, basis: "reconciled", evidenceRef: "test-fixture/complete-empty-history", reviewedAt: new Date().toISOString(),
  } }));
  assert.equal((await events(await alice.pay(quote))).at(-1).activity.state, "paid", "a held quote was not consumed");
});

test("an uncertain payment releases only after exact checkpointed gas consumption and keeps the proof", async (t) => {
  const transport = createProviderFetch({ allowPrivate: true });
  const { person, chain, store, events } = await start(t, {
    providerFetch: (url, init) => init?.headers?.["x-payment"] ? new Response("{}", { status: 403 }) : transport(url, init),
  });
  const alice = await person();
  const bob = await person();
  const item = (await alice.ask("SUI")).activity;
  const signed = await alice.sign(item);
  assert.equal((await events(await alice.pay(item, signed))).at(-1).activity.state, "uncertain");
  const stored = (await store.read(alice.address)).activity.find((a) => a.id === item.id);
  assert.deepEqual(stored.recovery, { network: "mainnet", transaction: signed.transaction });
  assert.equal(JSON.stringify(await store.read(alice.address)).includes(signed.signature), false);
  const gas = TransactionDataBuilder.fromBytes(fromBase64(signed.transaction)).gasData.payment[0];
  const conflict = "H9oQdHwAc1NLF8nY5pa1FgVz6RgfSm56ZN1YXCHnJfzd";
  const tx = { digest: conflict, checkpoint: null, effects: { transactionDigest: conflict, changedObjects: [{
    objectId: gas.objectId, inputState: "Exists", inputVersion: gas.version, inputDigest: gas.digest,
    inputOwner: { $kind: "AddressOwner", AddressOwner: alice.address }, outputState: "ObjectWrite", outputVersion: "2",
  }] } };
  const getTransaction = chain.client.core.getTransaction;
  chain.client.core.getTransaction = (options) => options.digest === conflict ? { Transaction: tx } : getTransaction(options);
  assert.equal((await bob.as("POST", `/api/requests/${item.id}/recheck`, { conflictingDigest: conflict })).status, 404);
  const recheck = async () => (await alice.as("POST", `/api/requests/${item.id}/recheck`, { conflictingDigest: conflict })).json();
  assert.equal((await recheck()).activity.state, "uncertain", "uncheckpointed consumption is insufficient");
  assert.equal((await (await alice.as("GET", "/api/me")).json()).spentMist, "1000000");
  tx.checkpoint = "345";
  const result = await recheck();
  assert.equal(result.activity.state, "refused");
  assert.equal(result.activity.invalidationProof.checkpoint, "345");
  assert.equal(result.activity.chainFailed, undefined, "invalidation is distinct from execution failure");
  await alice.ask("FREE"); // another ordinary write must not resurrect the reservation
  assert.equal((await (await alice.as("GET", "/api/me")).json()).spentMist, "0");
  assert.equal((await recheck()).activity.state, "refused");
});

test("signing in proves the wallet, and the signed message works once", async (t) => {
  const { call, person } = await start(t);
  assert.equal((await call("GET", "/api/me")).status, 401);
  const alice = await person();
  const me = await (await alice.as("GET", "/api/me")).json();
  assert.equal(me.address, alice.address);
  assert.deepEqual(me.limits, { perCallMist: "5000000", dailyMist: "20000000" });
  assert.deepEqual(me.activity, []);

  const replay = await call("POST", "/api/session", { body: { message: alice.message, signature: alice.signature } });
  assert.equal(replay.status, 401);
  assert.match((await replay.json()).error, /already used/);
});

test("a signature from another wallet or a forged session is refused", async (t) => {
  const { call } = await start(t);
  const owner = new Ed25519Keypair();
  const { message } = await (await call("POST", "/api/session/challenge", { body: { address: owner.toSuiAddress() } })).json();
  const { signature } = await new Ed25519Keypair().signPersonalMessage(new TextEncoder().encode(message));
  assert.equal((await call("POST", "/api/session", { body: { message, signature } })).status, 401);
  const edited = message.replace("Sign in to Edith", "Sign in to Evil");
  assert.equal((await call("POST", "/api/session", { body: { message: edited, signature } })).status, 401);
  assert.equal((await call("GET", "/api/me", { cookie: "edith_session=eyJrIjoic2Vzc2lvbiJ9.forged" })).status, 401);
});

test("the full journey: a paid failure is remembered and the repeat is declined with its evidence", async (t) => {
  const { person, chain } = await start(t);
  const alice = await person();

  const good = await alice.ask("SUI");
  assert.equal(good.step, "planned");
  assert.equal(good.activity.state, "awaiting");
  assert.equal(good.activity.amountMist, "1000000");
  const goodSteps = await (await alice.pay(good.activity)).text();
  assert.match(goodSteps, /"step":"settled"/);

  const junk = await alice.ask("ZZZ");
  assert.equal(junk.activity.state, "awaiting");
  const lines = (await (await alice.pay(junk.activity)).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.step), ["checking", "paying", "verified", "judged", "remembered", "settled"]);
  const paidJunk = lines.at(-1).activity;
  assert.equal(paidJunk.state, "paid");
  assert.equal(paidJunk.result, "failure");
  assert.equal(paidJunk.memory, "saved");
  assert.ok(paidJunk.blobId);
  assert.equal(chain.calls.execute, 2);

  const again = await alice.ask("ZZZ");
  assert.equal(again.activity.state, "blocked");
  assert.equal(again.activity.decision.source, "memory");
  assert.equal(again.activity.decision.basis.digest, paidJunk.digest);
  assert.equal(again.activity.amountMist, "1000000", "the amount it would have cost, from memory");
  assert.equal(chain.calls.execute, 2, "no second payment");

  const memory = await (await alice.as("GET", `/api/memory?url=${encodeURIComponent(`${good.activity.url.split("?")[0]}?ticker=ZZZ`)}`)).json();
  assert.ok(memory.records.some((r) => r.event === "paid" && r.result === "failure" && r.digest === paidJunk.digest));

  const me = await (await alice.as("GET", "/api/me")).json();
  assert.equal(me.spentMist, "2000000");
  assert.deepEqual(me.activity.map((a) => a.state), ["blocked", "paid", "paid"]);
});

test("each wallet sees only its own activity, memory and quotes", async (t) => {
  const { person, demo } = await start(t);
  const alice = await person();
  const bob = await person();
  const junk = await alice.ask("ZZZ");
  await (await alice.pay(junk.activity)).text();

  const stolen = await bob.pay(junk.activity, await alice.sign(junk.activity));
  assert.equal(stolen.status, 404, "bob cannot settle alice's quote");
  assert.deepEqual((await (await bob.as("GET", "/api/me")).json()).activity, []);
  const fresh = await bob.ask("ZZZ");
  assert.equal(fresh.activity.state, "awaiting", "alice's memory does not steer bob's payments");
  const bobMemory = await (await bob.as("GET", `/api/memory?url=${encodeURIComponent(`${demo.baseUrl}?ticker=ZZZ`)}`)).json();
  assert.deepEqual(bobMemory.records, []);
});

test("a quote is settled at most once, even with a double click", async (t) => {
  const { person, chain } = await start(t);
  const alice = await person();
  const { activity } = await alice.ask("SUI");
  const signed = await alice.sign(activity);
  const [first, second] = await Promise.all([alice.pay(activity, signed), alice.pay(activity, signed)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  await Promise.all([first.text(), second.text()]);
  assert.equal(chain.calls.execute, 1);
  assert.equal((await alice.pay(activity, signed)).status, 404, "a settled quote cannot be paid again");
});

test("a transfer that does not match the quote is not sent", async (t) => {
  const { person, chain } = await start(t);
  const alice = await person();
  const { activity } = await alice.ask("SUI");
  const lines = await (await alice.pay(activity, await alice.sign(activity, { amount: 3_000_000n }))).text();
  const last = JSON.parse(lines.trim().split("\n").at(-1));
  assert.equal(last.step, "error");
  assert.equal(last.activity.state, "failed");
  assert.match(last.message, /not the quoted/);
  assert.equal(chain.calls.execute, 0);
});

test("limits are validated, and a quote over them is blocked before signing", async (t) => {
  const { person } = await start(t);
  const alice = await person();
  assert.equal((await alice.as("PUT", "/api/limits", { perCallMist: "0", dailyMist: "1" })).status, 400);
  assert.equal((await alice.as("PUT", "/api/limits", { perCallMist: "5000000", dailyMist: "1000" })).status, 400);
  assert.equal((await alice.as("PUT", "/api/limits", { perCallMist: "99999999999", dailyMist: "99999999999" })).status, 400);
  const ok = await alice.as("PUT", "/api/limits", { perCallMist: "500000", dailyMist: "2000000" });
  assert.equal(ok.status, 200);

  const { activity } = await alice.ask("SUI");
  assert.equal(activity.state, "blocked");
  assert.equal(activity.decision.source, "limit");
  assert.match(activity.decision.reason, /limit per payment/);
});

test("cancelling a quote ends it; it cannot be paid afterwards", async (t) => {
  const { person } = await start(t);
  const alice = await person();
  const { activity } = await alice.ask("SUI");
  const cancelled = await (await alice.as("POST", `/api/requests/${activity.id}/cancel`)).json();
  assert.equal(cancelled.activity.state, "cancelled");
  assert.equal((await alice.pay(activity)).status, 404);
});

test("unsafe addresses and cross-site requests are refused", async (t) => {
  const { base, person } = await start(t);
  const alice = await person();
  const bad = await alice.as("POST", "/api/requests", { url: "ftp://x" });
  assert.equal(bad.status, 400);
  assert.equal((await fetch(`${base}/api/requests`, { method: "POST", headers: { cookie: alice.cookie }, body: "url=x" })).status, 415);
  const cross = await fetch(`${base}/api/requests`, { method: "POST", headers: { cookie: alice.cookie, "content-type": "application/json", origin: "https://evil.example" }, body: "{}" });
  assert.equal(cross.status, 403);
});

test("present handles legacy records", () => {
  const legacy = present({ event: "failure", key: "GET_/quote?ticker=ZZZ", network: "mainnet", paid: "1000000", digest: "D", reason: "HTTP_502_x", at: "t" });
  assert.equal(legacy.kind, "transient");
  assert.equal(legacy.request, "GET /quote?ticker=ZZZ");
});

test("static files are served without escaping the build directory", async (t) => {
  const dir = tmp("edith-web-");
  writeFileSync(join(dir, "index.html"), "<p>app</p>");
  const { base } = await start(t, { staticDir: dir });
  assert.equal(await (await fetch(`${base}/pricing`)).text(), "<p>app</p>", "page routes fall back to the site");
  assert.equal(await (await fetch(`${base}/..%2f..%2fpackage.json`)).text(), "<p>app</p>");
});

test("a section with its own page serves it for every route under it", async (t) => {
  const dir = tmp("edith-web-");
  writeFileSync(join(dir, "index.html"), "<p>site</p>");
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "index.html"), "<p>console</p>");
  const { base } = await start(t, { staticDir: dir });
  assert.equal(await (await fetch(`${base}/app`)).text(), "<p>console</p>");
  assert.equal(await (await fetch(`${base}/app/memory`)).text(), "<p>console</p>");
  assert.equal(await (await fetch(`${base}/pricing`)).text(), "<p>site</p>");
});

test("an agent asks, the owner approves in their wallet, and the agent gets the answer", async (t) => {
  const { person, demo, chain } = await start(t);
  const alice = await person();
  const bot = await alice.connectAgent();
  assert.match(bot.token, /^ek_[0-9a-f]{64}\./);
  assert.equal(bot.agent.secretHash, undefined, "the key's hash never leaves the server");

  const asked = await (await bot.call("POST", "/v1/requests", { url: `${demo.baseUrl}?ticker=SUI` })).json();
  assert.equal(asked.state, "awaiting");
  assert.equal(asked.approval.needed, true);
  assert.equal(asked.approval.review, `http://edith.test/app?review=${asked.id}`);
  assert.equal(chain.calls.execute, 0, "an agent's request alone never pays");

  const me = await (await alice.as("GET", "/api/me")).json();
  const item = me.activity.find((a) => a.id === asked.id);
  assert.deepEqual(item.source, { kind: "agent", agentId: bot.agent.id, name: "Research bot" });
  assert.equal(me.agents[0].lastUsedAt !== null, true);

  assert.match(await (await alice.pay(item)).text(), /"step":"settled"/);
  const answered = await (await bot.call("GET", `/v1/requests/${asked.id}`)).json();
  assert.equal(answered.state, "paid");
  assert.equal(answered.result, "success");
  assert.match(answered.body, /"ticker": "SUI"/);
  assert.ok(answered.digest);
});

test("an agent's repeat of a remembered failure is refused at once, with no approval needed", async (t) => {
  const { person, demo, chain } = await start(t);
  const alice = await person();
  const junk = await alice.ask("ZZZ");
  await (await alice.pay(junk.activity)).text();
  const bot = await alice.connectAgent();
  const asked = await (await bot.call("POST", "/v1/requests", { url: `${demo.baseUrl}?ticker=ZZZ` })).json();
  assert.equal(asked.state, "blocked");
  assert.equal(asked.decision.source, "memory");
  assert.equal(asked.approval, null);
  assert.equal(chain.calls.execute, 1);
});

test("agent keys are scoped: no cookies, no other wallet, no revoked or forged keys", async (t) => {
  const { person, demo, base } = await start(t);
  const alice = await person();
  const bob = await person();
  const aliceBot = await alice.connectAgent();
  const bobBot = await bob.connectAgent("Bob's bot");
  const asked = await (await aliceBot.call("POST", "/v1/requests", { url: `${demo.baseUrl}?ticker=SUI` })).json();

  assert.equal((await bobBot.call("GET", `/v1/requests/${asked.id}`)).status, 404, "another wallet's agent cannot read it");
  const secondBot = await alice.connectAgent("Second bot");
  assert.equal((await secondBot.call("GET", `/v1/requests/${asked.id}`)).status, 404, "another agent of the same wallet cannot read it");
  assert.equal((await fetch(`${base}/v1/requests/${asked.id}`, { headers: { cookie: alice.cookie } })).status, 401, "the session cookie is not an agent key");
  assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${aliceBot.token}` } })).status, 401, "an agent key is not a session");

  const forged = aliceBot.token.replace(/^ek_[0-9a-f]{64}/, `ek_${bob.address.slice(2)}`);
  assert.equal((await fetch(`${base}/v1/requests/${asked.id}`, { headers: { authorization: `Bearer ${forged}` } })).status, 401);
  const tampered = `${aliceBot.token.slice(0, -1)}${aliceBot.token.endsWith("A") ? "B" : "A"}`;
  assert.equal((await fetch(`${base}/v1/requests/${asked.id}`, { headers: { authorization: `Bearer ${tampered}` } })).status, 401);

  assert.equal((await alice.as("POST", `/api/agents/${aliceBot.agent.id}/revoke`)).status, 200);
  assert.equal((await aliceBot.call("GET", `/v1/requests/${asked.id}`)).status, 401, "a disconnected agent is locked out");
  assert.equal((await bob.as("POST", `/api/agents/${aliceBot.agent.id}/revoke`)).status, 404, "nobody else can manage this wallet's agents");
  assert.equal((await aliceBot.call("POST", `/v1/requests/${asked.id}/pay`)).status, 404, "there is no way for an agent to pay");
});

test("an agent can withdraw a request still waiting for approval", async (t) => {
  const { person, demo } = await start(t);
  const alice = await person();
  const bot = await alice.connectAgent();
  const asked = await (await bot.call("POST", "/v1/requests", { url: `${demo.baseUrl}?ticker=SUI` })).json();
  const withdrawn = await (await bot.call("POST", `/v1/requests/${asked.id}/cancel`)).json();
  assert.equal(withdrawn.state, "cancelled");
  const me = await (await alice.as("GET", "/api/me")).json();
  assert.equal((await alice.pay(me.activity[0])).status, 404, "the owner can no longer pay a withdrawn request");
});

test("agent names are validated and the number of agents is capped", async (t) => {
  const { person } = await start(t);
  const alice = await person();
  assert.equal((await alice.as("POST", "/api/agents", { name: "<script>" })).status, 400);
  assert.equal((await alice.as("POST", "/api/agents", { name: "" })).status, 400);
  for (let i = 0; i < 10; i++) await alice.connectAgent(`Bot ${i}`);
  assert.equal((await alice.as("POST", "/api/agents", { name: "One too many" })).status, 409);
});

test("an agent's request outlives its quote: the owner gets a fresh price on review, then pays", async (t) => {
  const { person, demo } = await start(t);
  const alice = await person();
  const bot = await alice.connectAgent();
  const asked = await (await bot.call("POST", "/v1/requests", { url: `${demo.baseUrl}?ticker=SUI` })).json();

  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60_000; // ten minutes later: the 4-minute quote is gone
  t.after(() => { Date.now = realNow; });
  const later = (await (await alice.as("GET", "/api/me")).json()).activity.find((a) => a.id === asked.id);
  assert.equal(later.state, "awaiting", "still waiting for its owner");
  assert.equal(later.stale, true);
  assert.equal((await alice.pay(later)).status, 410, "an expired quote cannot be paid");

  const { activity: fresh } = await (await alice.as("POST", `/api/requests/${asked.id}/requote`)).json();
  assert.equal(fresh.state, "awaiting");
  assert.equal(fresh.stale, false);
  assert.ok(Date.parse(fresh.expiresAt) > Date.now(), "a new price window");
  assert.match(await (await alice.pay(fresh)).text(), /"step":"settled"/);
  assert.equal((await (await bot.call("GET", `/v1/requests/${asked.id}`)).json()).state, "paid");
});
