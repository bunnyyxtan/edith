import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHandler } from "../src/app.mjs";

test("private-provider development override is rejected before any public deployment connects to services", async () => {
  const configured = {
    PUBLIC_ORIGIN: "https://edith.example", ALLOW_PRIVATE_PROVIDERS: "1",
    SESSION_SECRET: "test", SERVER_CHALLENGE_SECRET: "test", TATUM_API_KEY: "test",
    MEMWAL_PRIVATE_KEY: "test", MEMWAL_ACCOUNT_ID: "test", SERVER_SUI_ADDRESS: "test",
    SUI_NETWORK: "mainnet", DATABASE_URL: "not-a-real-database",
  };
  for (const override of [{}, { VERCEL: "1" }, { PUBLIC_ORIGIN: "http://localhost:4030", NODE_ENV: "production" }, { PUBLIC_ORIGIN: "http://public.example" }]) {
    await assert.rejects(buildHandler({ ...configured, ...override }), /only permitted for local development/);
  }
});
