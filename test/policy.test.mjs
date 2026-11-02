import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyResponse, decide, POLICY } from "../src/policy.mjs";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

const outcome = (key, result, extra = {}) => ({ key, endpoint: "GET_/quote", result, paid: 1_000_000n, digest: "d", at: ago(60 * MIN), ...extra });
const ok = (key, extra) => outcome(key, "success", extra);
const fail = (key, kind, extra) => outcome(key, "failure", { kind, reason: kind, ...extra });

const ZZZ = "GET_/quote?ticker=ZZZ";
const SUI = "GET_/quote?ticker=SUI";

test("pays when nothing is remembered", () => {
  assert.equal(decide([], { key: ZZZ, now: NOW }).action, "pay");
});

test("skips a request that failed deterministically, however long ago", () => {
  const history = [fail(ZZZ, "bad_payload", { at: ago(30 * 24 * 60 * MIN) })];
  const d = decide(history, { key: ZZZ, now: NOW });
  assert.equal(d.action, "skip");
  assert.equal(d.saved, 1_000_000n);
});

test("skips a rejected (4xx) request", () => {
  assert.equal(decide([fail(ZZZ, "rejected")], { key: ZZZ, now: NOW }).action, "skip");
});

test("transient failures cool down, then allow a retry", () => {
  const recent = [fail(ZZZ, "transient", { at: ago(POLICY.transientCooldownMs - MIN) })];
  const old = [fail(ZZZ, "transient", { at: ago(POLICY.transientCooldownMs + MIN) })];
  assert.equal(decide(recent, { key: ZZZ, now: NOW }).action, "skip");
  const retry = decide(old, { key: ZZZ, now: NOW });
  assert.equal(retry.action, "pay");
  assert.match(retry.reason, /cooled down/);
});

test("a later success clears an earlier failure of the same request", () => {
  const history = [fail(ZZZ, "bad_payload", { at: ago(120 * MIN) }), ok(ZZZ, { at: ago(10 * MIN) })];
  assert.equal(decide(history, { key: ZZZ, now: NOW }).action, "pay");
});

test("a failure on one request does not block a different request", () => {
  assert.equal(decide([fail(ZZZ, "bad_payload")], { key: SUI, now: NOW }).action, "pay");
});

test("an endpoint with mostly failed paid calls is skipped even for unseen requests", () => {
  const history = [fail("GET_/quote?ticker=A", "bad_payload"), fail("GET_/quote?ticker=B", "bad_payload"), fail("GET_/quote?ticker=C", "rejected"), ok(SUI)];
  const d = decide(history, { key: "GET_/quote?ticker=NEW", now: NOW });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /3 of 4/);
});

test("an endpoint with enough successful requests stays open", () => {
  const history = [fail("GET_/quote?ticker=A", "bad_payload"), fail("GET_/quote?ticker=B", "bad_payload"), fail("GET_/quote?ticker=C", "bad_payload"), ok(SUI), ok("GET_/quote?ticker=WAL"), ok("GET_/quote?ticker=BTC")];
  assert.equal(decide(history, { key: "GET_/quote?ticker=NEW", now: NOW }).action, "pay");
});

test("reliability counts distinct requests, not retries of one request", () => {
  const retries = [1, 2, 3].map((h) => fail(ZZZ, "transient", { at: ago(h * 60 * MIN) }));
  assert.equal(decide([...retries, ok(SUI)], { key: "GET_/quote?ticker=NEW", now: NOW }).action, "pay");
});

test("transient failures never make an endpoint unreliable", () => {
  const cooled = { at: ago(POLICY.transientCooldownMs + MIN) };
  const history = [fail("GET_/quote?ticker=A", "transient", cooled), fail("GET_/quote?ticker=B", "transient", cooled), fail("GET_/quote?ticker=C", "transient", cooled), fail(ZZZ, "bad_payload"), ok(SUI)];
  assert.equal(decide(history, { key: "GET_/quote?ticker=A", now: NOW }).action, "pay", "a cooled-down request can retry");
  assert.equal(decide(history, { key: "GET_/quote?ticker=NEW", now: NOW }).action, "pay");
});

test("a request that last succeeded stays payable on an unreliable endpoint", () => {
  const history = [fail("GET_/quote?ticker=A", "bad_payload"), fail("GET_/quote?ticker=B", "bad_payload"), fail("GET_/quote?ticker=C", "bad_payload"), ok(SUI)];
  assert.equal(decide(history, { key: "GET_/quote?ticker=NEW", now: NOW }).action, "skip");
  assert.equal(decide(history, { key: SUI, now: NOW }).action, "pay");
});

test("refuses a price spike relative to what paid off before", () => {
  const history = [ok(SUI, { paid: 1_000_000n })];
  assert.equal(decide(history, { key: SUI, price: 2_000_000n, now: NOW }).action, "pay");
  const d = decide(history, { key: SUI, price: 2_000_001n, now: NOW });
  assert.equal(d.action, "skip");
  assert.match(d.reason, /price/);
});

test("prices are not judged without a successful baseline", () => {
  assert.equal(decide([fail(ZZZ, "transient", { at: ago(POLICY.transientCooldownMs * 2), paid: 1n })], { key: SUI, price: 999n, now: NOW }).action, "pay");
});

test("classifyResponse separates useful, junk, transient and rejected responses", () => {
  const useful = (b) => typeof b?.priceUsd === "number";
  assert.equal(classifyResponse(200, { priceUsd: 1 }, useful), null);
  assert.deepEqual(classifyResponse(200, {}, useful), { kind: "bad_payload", reason: "empty or malformed payload" });
  assert.equal(classifyResponse(502, { error: "upstream timeout" }, useful).kind, "transient");
  assert.equal(classifyResponse(429, null, useful).kind, "transient");
  assert.deepEqual(classifyResponse(410, { error: "ticker delisted" }, useful), { kind: "rejected", reason: "HTTP 410 ticker delisted" });
});
