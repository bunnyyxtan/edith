// Offline check of the decision logic: uses MemWalMock, no network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemWalMock } from "@mysten-incubation/memwal";
import { requestKey, findFailure, rememberEvent, parseRecord } from "../src/memory.mjs";

test("requestKey ignores host and query order", () => {
  assert.equal(requestKey("get", "http://a:1/quote?b=2&a=1"), requestKey("GET", "http://b:2/quote?a=1&b=2"));
});

test("recalls only exact-key failures, newest first", async () => {
  const memory = new MemWalMock({ namespace: "edith" });
  const bad = requestKey("GET", "http://x/quote?ticker=ZZZ");
  const near = requestKey("GET", "http://x/quote?ticker=ZZ");
  await rememberEvent(memory, { event: "failure", key: near, network: "mainnet", paid: 1, digest: "d0", reason: "other" });
  await rememberEvent(memory, { event: "avoided", key: bad, network: "mainnet", saved: 1 });
  await rememberEvent(memory, { event: "failure", key: bad, network: "devnet", paid: 1, digest: "dd", reason: "other" });
  assert.equal(await findFailure(memory, bad, "mainnet"), null, "avoided events, near keys and other networks must not match");

  await rememberEvent(memory, { event: "failure", key: bad, network: "mainnet", paid: 1000000, digest: "d1", reason: "empty or malformed payload" });
  const hit = await findFailure(memory, bad, "mainnet");
  assert.equal(hit.digest, "d1");
  assert.equal(hit.reason, "empty_or_malformed_payload");
});

test("parseRecord round-trips values containing '='", () => {
  assert.deepEqual(parseRecord("key=GET_/q?a=1 x=y"), { key: "GET_/q?a=1", x: "y" });
});
