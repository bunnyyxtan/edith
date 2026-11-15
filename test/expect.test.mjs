import { test } from "node:test";
import assert from "node:assert/strict";
import { ExpectError, cacheSeconds, checkExpect, parseExpect } from "../src/expect.mjs";

const NOW = Date.parse("2026-11-15T12:00:00Z");

test("parseExpect keeps known rules and refuses anything else", () => {
  assert.equal(parseExpect(undefined), null);
  assert.equal(parseExpect({}), null);
  assert.deepEqual(parseExpect({ "data.price": { type: "number", min: 0, max: 10 } }), { "data.price": { type: "number", min: 0, max: 10 } });
  for (const bad of [[], "x", { "a b": {} }, { a: { type: "date" } }, { a: { min: "1" } }, { a: { min: 2, max: 1 } }, { a: { maxAgeSec: 0 } }, { a: { equals: {} } }, { a: { regex: "." } }]) {
    assert.throws(() => parseExpect(bad), ExpectError, JSON.stringify(bad));
  }
  assert.throws(() => parseExpect(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, {}]))), ExpectError);
});

test("checkExpect names the first broken rule; stale data is only transient", () => {
  const body = { quote: { price: 3.41, symbol: "SUI", at: "2026-11-15T11:59:00Z" } };
  assert.equal(checkExpect(body, null), null);
  assert.equal(checkExpect(body, { "quote.price": { type: "number", min: 1, max: 5 }, "quote.at": { maxAgeSec: 120 } }, NOW), null);
  assert.deepEqual(checkExpect(body, { "quote.price": { max: 1 } }, NOW), { kind: "inaccurate", reason: "expectation failed: quote.price 3.41 is above 1" });
  assert.equal(checkExpect(body, { "quote.volume": {} }, NOW).reason, "expectation failed: quote.volume is missing");
  assert.equal(checkExpect(body, { "quote.symbol": { equals: "BTC" } }, NOW).kind, "inaccurate");
  assert.equal(checkExpect(body, { "quote.symbol": { type: "number" } }, NOW).kind, "inaccurate");
  assert.equal(checkExpect(body, { "quote.at": { maxAgeSec: 30 } }, NOW).kind, "transient");
  assert.equal(checkExpect({ a: Object.create({ inherited: 1 }) }, { "a.inherited": {} }, NOW).kind, "inaccurate", "own fields only");
});

test("cacheSeconds reads the provider's max-age and honours no-store", () => {
  assert.equal(cacheSeconds("private, max-age=60"), 60);
  assert.equal(cacheSeconds("max-age=60, no-store"), 0);
  assert.equal(cacheSeconds("s-maxage=60"), 0);
  assert.equal(cacheSeconds(null), 0);
});
