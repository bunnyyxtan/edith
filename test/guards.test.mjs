// Provider fetching (SSRF guard) and the per-wallet store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderFetch, isInternalAddress, UnsafeUrlError } from "../src/net.mjs";
import { createStore, spentToday, withActivity } from "../src/store.mjs";

const ALICE = `0x${"a".repeat(64)}`;

test("internal addresses are recognised, public ones are not", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.equal(isInternalAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isInternalAddress(address), false, address);
});

test("provider fetch refuses internal targets and never follows redirects", async () => {
  const seen = [];
  const fetch = async (url, init) => { seen.push({ url: String(url), redirect: init.redirect }); return new Response("{}"); };
  const providerFetch = createProviderFetch({ fetch, demo: { origin: "https://edith.example", prefix: "/demo", target: "http://127.0.0.1:4030" } });
  await assert.rejects(providerFetch("http://127.0.0.1:4030/api/me"), UnsafeUrlError);
  await assert.rejects(providerFetch("http://[::1]/"), UnsafeUrlError);
  await assert.rejects(providerFetch("http://169.254.169.254/latest/meta-data"), UnsafeUrlError);
  await providerFetch("https://edith.example/demo/quote?ticker=SUI");
  await providerFetch("http://8.8.8.8/quote");
  assert.deepEqual(seen, [
    { url: "http://127.0.0.1:4030/demo/quote?ticker=SUI", redirect: "manual" },
    { url: "http://8.8.8.8/quote", redirect: "manual" },
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
