// Provider fetching (SSRF guard) and the per-wallet store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { createProviderFetch, isInternalAddress, UnsafeUrlError, MAX_PROVIDER_RESPONSE_BYTES, ProviderResponseError } from "../src/net.mjs";
import { createStore, spentToday, withActivity } from "../src/store.mjs";

const ALICE = `0x${"a".repeat(64)}`;

// Consume lookup at the connection boundary, like Node's HTTP(S) socket.
function connector(onConnect = () => {}, { status = 200, headers = {}, all = true } = {}) {
  return (url, options, respond) => {
    const req = new EventEmitter();
    req.end = () => {
      const connected = (err, result, family) => {
        if (err) return req.emit("error", err);
        onConnect(url, options, all ? result : [{ address: result, family }]);
        const res = Readable.from([Buffer.from("{}")]);
        res.statusCode = status;
        res.headers = headers;
        respond(res);
      };
      if (url.hostname === "localhost" || url.hostname.endsWith(".example")) options.lookup(url.hostname, { all }, connected);
      else queueMicrotask(() => connected(null, []));
    };
    return req;
  };
}

test("DNS rebinding cannot change the address between validation and connection", async () => {
  for (const all of [true, false]) {
    let resolutions = 0;
    const connections = [];
    const fetch = createProviderFetch({
      lookup: async () => [{ address: ++resolutions === 1 ? "8.8.8.8" : "127.0.0.1", family: 4 }],
      transport: connector((url, options, addresses) => {
        assert.equal(url.hostname, "provider.example", "original Host and TLS identity are preserved");
        assert.equal(options.agent, false, "no pooled socket can bypass the checked lookup");
        assert.equal(options.rejectUnauthorized, undefined, "TLS verification is not disabled");
        connections.push(addresses);
      }, { all }),
    });
    await fetch("https://provider.example/data");
    assert.equal(resolutions, 1);
    assert.deepEqual(connections, [[{ address: "8.8.8.8", family: 4 }]]);
    await assert.rejects(fetch("https://provider.example/data", { headers: { "x-payment": "signed" } }), UnsafeUrlError);
    assert.equal(connections.length, 1, "a private resolution receives no payment");
  }
});

test("mixed, empty and private DNS results fail closed, including IPv4-mapped IPv6", async () => {
  for (const addresses of [[], [{ address: "8.8.8.8", family: 4 }, { address: "::1", family: 6 }], [{ address: "::ffff:7f00:1", family: 6 }]]) {
    const fetch = createProviderFetch({ lookup: async () => addresses, transport: connector(() => assert.fail("must not connect")) });
    await assert.rejects(fetch("https://provider.example/data"), UnsafeUrlError);
  }
  const fetch = createProviderFetch({ transport: connector(() => assert.fail("must not connect")) });
  await assert.rejects(fetch("https://[::ffff:127.0.0.1]/data"), UnsafeUrlError);
});

test("the HTTP development exception is explicit and restricted to loopback", async () => {
  const fetch = createProviderFetch({ allowPrivate: true, transport: connector(), lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
  for (const url of ["http://8.8.8.8/data", "http://10.0.0.1/data", "http://provider.example/data", "ftp://localhost/data", "https://user:pass@provider.example/data"]) {
    await assert.rejects(fetch(url), UnsafeUrlError);
  }
  await assert.rejects(fetch("http://localhost/data"), UnsafeUrlError, "even localhost must resolve to loopback");
});

test("native transport preserves Host and payment headers without following redirects", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, host: req.headers.host, payment: req.headers["x-payment"] });
    res.writeHead(302, { location: "/private" });
    res.end("{}");
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let lookups = 0;
  const fetch = createProviderFetch({ allowPrivate: true, lookup: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; } });
  const host = `localhost:${server.address().port}`;
  const response = await fetch(`http://${host}/quote`, { headers: { "x-payment": "signed" } });
  assert.equal(response.status, 302);
  assert.deepEqual(await response.json(), {});
  assert.equal(lookups, 1);
  assert.deepEqual(requests, [{ url: "/quote", host, payment: "signed" }]);
});

test("native transport reads compressed JSON and aborts stalled response bodies", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/stall") {
      res.writeHead(200);
      res.write('{"partial":');
      return;
    }
    res.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" });
    res.end(gzipSync('{"priceUsd":3.41}'));
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await createProviderFetch({ allowPrivate: true })(base)).json(), { priceUsd: 3.41 });
  await assert.rejects(createProviderFetch({ allowPrivate: true, timeoutMs: 100 })(`${base}/stall`), (err) => err.name === "AbortError");
});

test("provider bodies have independent wire and decoded limits and overflowing sockets close", { timeout: 10000 }, async (t) => {
  const limit = MAX_PROVIDER_RESPONSE_BYTES;
  const full = Buffer.alloc(limit, "x");
  const oversized = Buffer.alloc(limit + 1, "x");
  const bodies = new Map([
    ["/exact", { body: full }],
    ["/plain", { body: oversized }],
    ["/gzip", { encoding: "gzip", body: gzipSync(oversized) }],
    ["/deflate", { encoding: "deflate", body: deflateSync(oversized) }],
    ["/br", { encoding: "br", body: brotliCompressSync(oversized) }],
    ["/gzip-exact", { encoding: "gzip", body: gzipSync(full) }],
    ["/members", { encoding: "gzip", body: Buffer.concat([gzipSync(full), gzipSync(Buffer.from("x"))]) }],
    ["/wire", { encoding: "gzip", body: gzipSync(randomBytes(limit), { level: 0 }) }],
    ["/corrupt", { encoding: "gzip", body: Buffer.from("broken gzip") }],
    ["/unknown", { encoding: "gzip, br", body: Buffer.from("{}") }],
  ]);
  const closed = new Map();
  for (const path of [...bodies.keys(), "/length", "/stall"]) closed.set(path, Promise.withResolvers());
  const server = createServer((req, res) => {
    res.once("close", closed.get(req.url).resolve);
    if (req.url === "/length") {
      res.writeHead(200, { "content-length": String(limit + 1) });
      res.flushHeaders(); // no body: reject from headers immediately, not after the timeout
      return;
    }
    if (req.url === "/stall") {
      res.writeHead(200, { "content-encoding": "gzip" });
      res.write(gzipSync(Buffer.from("{}")));
      return;
    }
    const { body, encoding } = bodies.get(req.url);
    res.writeHead(200, { ...(encoding ? { "content-encoding": encoding } : {}), "transfer-encoding": "chunked" });
    for (let i = 0; i < body.length; i += 4096) res.write(body.subarray(i, i + 4096));
    if (req.url === "/exact" || req.url === "/gzip-exact") res.end();
    // Keep abusive responses open: a successful rejection must actively terminate them.
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fetch = createProviderFetch({ allowPrivate: true, timeoutMs: 2000 });
  for (const path of ["/exact", "/gzip-exact"]) assert.equal((await (await fetch(base + path)).arrayBuffer()).byteLength, limit);
  for (const path of ["/plain", "/gzip", "/deflate", "/br", "/members", "/wire", "/length", "/unknown"]) {
    await assert.rejects(fetch(base + path), ProviderResponseError, path);
    await closed.get(path).promise;
  }
  await assert.rejects(fetch(base + "/corrupt"), /header|compression|data/i);
  await closed.get("/corrupt").promise;
  await assert.rejects(createProviderFetch({ allowPrivate: true, timeoutMs: 100 })(base + "/stall"), (err) => err.name === "AbortError");
  await closed.get("/stall").promise;
});

test("recent spending survives activity eviction and a file-store restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edith-ledger-"));
  const store = createStore(dir);
  const now = Date.now();
  await store.update(ALICE, (user) => {
    user = withActivity(user, "paid", { at: new Date(now - 1000).toISOString(), state: "paid", amountMist: "20000000" });
    for (let i = 0; i < 210; i++) user = withActivity(user, `free${i}`, { at: new Date(now + i).toISOString(), state: "free" });
    return user;
  });
  const restored = await createStore(dir).read(ALICE);
  assert.equal(restored.activity.length, 200);
  assert.equal(restored.activity.some((a) => a.id === "paid"), false);
  assert.equal(spentToday(restored), 20_000_000n);
});

test("pending signatures never age out and settled spending uses payment time, not quote time", () => {
  const now = Date.now();
  const old = new Date(now - 48 * 60 * 60_000).toISOString();
  let user = { activity: [] };
  user = withActivity(user, "late", { at: old, state: "settling", amountMist: "100", settlingAt: new Date(now).toISOString() });
  user = withActivity(user, "unknown", { at: old, state: "uncertain", amountMist: "10" });
  for (let i = 0; i < 210; i++) user = withActivity(user, `free${i}`, { at: new Date(now + i).toISOString(), state: "free" });
  assert.equal(spentToday(user, now + 48 * 60 * 60_000), 110n);
  assert.ok(user.activity.some((a) => a.id === "unknown"), "recheck remains available");
  user = withActivity(user, "late", { state: "paid", verifiedAt: new Date(now).toISOString() });
  assert.ok(user.activity.some((a) => a.id === "late"), "the late settlement result is returned to the UI");
  assert.equal(spentToday(user, now), 110n);
  assert.equal(spentToday(user, now + 25 * 60 * 60_000), 10n);
  user = withActivity(user, "unknown", { state: "refused", chainFailed: true });
  assert.ok(user.activity.some((a) => a.id === "unknown"), "the finalized failure result is returned to the UI");
  assert.equal(spentToday(user, now), 100n);
});

test("legacy records migrate before truncation and old refused signatures remain reserved", () => {
  const now = Date.now();
  const user = { activity: [
    { id: "paid", at: new Date(now - 1000).toISOString(), state: "paid", amountMist: "100" },
    { id: "refused", at: new Date(now - 48 * 60 * 60_000).toISOString(), state: "refused", digest: "D", amountMist: "10" },
  ] };
  assert.equal(spentToday(user), 110n);
  const migrated = withActivity(user, "free", { at: new Date(now).toISOString(), state: "free" });
  assert.equal(spentToday(migrated), 110n);
  assert.equal(migrated.activity.find((a) => a.id === "refused").state, "uncertain");
});

test("internal addresses are recognised, public ones are not", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isInternalAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isInternalAddress(address), false, address);
});

test("provider fetch refuses internal targets and never follows redirects", async () => {
  const seen = [];
  const transport = connector((url) => seen.push(String(url)), { status: 302, headers: { location: "http://127.0.0.1/private" } });
  const providerFetch = createProviderFetch({ transport, demo: { origin: "https://edith.example", prefix: "/demo", target: "http://127.0.0.1:4030" } });
  await assert.rejects(providerFetch("http://127.0.0.1:4030/api/me"), UnsafeUrlError);
  await assert.rejects(providerFetch("http://[::1]/"), UnsafeUrlError);
  await assert.rejects(providerFetch("http://169.254.169.254/latest/meta-data"), UnsafeUrlError);
  await providerFetch("https://edith.example/demo/quote?ticker=SUI");
  await assert.rejects(providerFetch("http://8.8.8.8/quote"), /HTTPS/);
  assert.equal((await providerFetch("https://8.8.8.8/quote")).status, 302);
  assert.deepEqual(seen, [
    "http://127.0.0.1:4030/demo/quote?ticker=SUI",
    "https://8.8.8.8/quote",
  ]);
});

test("concurrent updates for one wallet never lose each other's changes", async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), "edith-store-")));
  const at = new Date().toISOString();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(ALICE, (u) => withActivity(u, `id${i}`, { at, state: "paid", amountMist: "1000" }))));
  const user = await store.read(ALICE);
  assert.equal(user.activity.length, 20);
  assert.equal(spentToday(user), 20_000n);
});

test("a failed update leaves the stored record untouched", async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), "edith-store-")));
  await store.update(ALICE, (u) => ({ ...u, limits: { perCallMist: "1", dailyMist: "2" } }));
  await assert.rejects(store.update(ALICE, () => { throw new Error("over limit"); }), /over limit/);
  assert.deepEqual((await store.read(ALICE)).limits, { perCallMist: "1", dailyMist: "2" });
  await assert.rejects(store.read("../../etc/passwd"), /invalid address/);
});

test("only money that moved or may have moved counts toward the 24-hour limit", () => {
  const now = Date.now();
  const recent = new Date(now - 60_000).toISOString();
  const old = new Date(now - 25 * 60 * 60_000).toISOString();
  const user = { activity: [
    { state: "paid", at: recent, amountMist: "100" },
    { state: "uncertain", at: recent, amountMist: "10" },
    { state: "settling", at: recent, amountMist: "1" },
    { state: "blocked", at: recent, amountMist: "1000" },
    { state: "failed", at: recent, amountMist: "1000" },
    { state: "paid", at: old, amountMist: "1000" },
  ] };
  assert.equal(spentToday(user, now), 111n);
});
