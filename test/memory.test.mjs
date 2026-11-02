// Offline checks of memory records and history loading, using the SDK's MemWalMock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemWalMock } from "@mysten-incubation/memwal";
import { describeRequest, formatRecord, loadHistory, parseRecord, rememberEvent, toOutcome } from "../src/memory.mjs";

const CONTEXT = { endpoint: "GET_/quote", provider: "api.example:4020", network: "mainnet" };

test("describeRequest ignores query order and separates host from request identity", () => {
  const a = describeRequest("get", "http://a.example:1/quote?b=2&a=1");
  const b = describeRequest("GET", "http://b.example:2/quote?a=1&b=2");
  assert.equal(a.key, b.key);
  assert.equal(a.endpoint, "GET_/quote");
  assert.notEqual(a.provider, b.provider);
});

test("records round-trip, including values that contain '=' and spaces", () => {
  const text = formatRecord({ key: "GET /q?a=1", reason: "HTTP 502 upstream timeout" });
  assert.deepEqual(parseRecord(text), { key: "GET_/q?a=1", reason: "HTTP_502_upstream_timeout" });
});

test("legacy failure records still count as failures", () => {
  const legacy = parseRecord("event=failure key=GET_/quote?ticker=ZZZ network=mainnet paid=1000000 digest=d reason=empty_or_malformed_payload at=2026-11-02T11:12:16.577Z");
  const outcome = toOutcome(legacy);
  assert.equal(outcome.result, "failure");
  assert.equal(outcome.kind, "bad_payload");
  assert.equal(outcome.endpoint, "GET_/quote");
  assert.equal(outcome.paid, 1_000_000n);
  assert.equal(toOutcome(parseRecord("event=failure key=GET_/quote network=mainnet reason=HTTP_502_x")).kind, "transient");
  assert.equal(toOutcome(parseRecord("event=avoided key=GET_/quote")), null);
});

test("loadHistory keeps only outcomes for the same endpoint, provider and network", async () => {
  const memory = new MemWalMock({ namespace: "edith" });
  const base = { event: "outcome", ...CONTEXT, paid: 1, digest: "d" };
  await rememberEvent(memory, { ...base, key: "GET_/quote?ticker=ZZZ", result: "failure", kind: "bad_payload" });
  await rememberEvent(memory, { ...base, key: "GET_/quote?ticker=SUI", result: "success" });
  await rememberEvent(memory, { ...base, network: "devnet", key: "GET_/quote?ticker=SUI", result: "success" });
  await rememberEvent(memory, { ...base, provider: "other.example", key: "GET_/quote?ticker=SUI", result: "success" });
  await rememberEvent(memory, { ...base, endpoint: "GET_/news", key: "GET_/news", result: "success" });
  await rememberEvent(memory, { event: "avoided", ...CONTEXT, key: "GET_/quote?ticker=ZZZ" });

  const history = await loadHistory(memory, CONTEXT);
  assert.deepEqual(history.map((r) => r.result).sort(), ["failure", "success"]);
});
