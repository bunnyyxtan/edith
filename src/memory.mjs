// Edith's long-term memory of paid requests, stored in Walrus Memory.
// Records are single-line key=value text so recall stays semantic but matching stays exact.
import { MemWal } from "@mysten-incubation/memwal";

export const NAMESPACE = "edith";

export function createMemory(env = process.env) {
  if (!env.MEMWAL_PRIVATE_KEY || !env.MEMWAL_ACCOUNT_ID) throw new Error("MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID are required");
  return MemWal.create({
    key: env.MEMWAL_PRIVATE_KEY,
    accountId: env.MEMWAL_ACCOUNT_ID,
    serverUrl: env.MEMWAL_SERVER_URL,
    namespace: NAMESPACE,
  });
}

// Canonical request key: method + path + sorted query, host excluded so it survives redeploys.
export function requestKey(method, url) {
  const u = new URL(url);
  u.searchParams.sort();
  return `${method.toUpperCase()} ${u.pathname}${u.search}`;
}

export function formatRecord(fields) {
  return Object.entries(fields).map(([k, v]) => `${k}=${String(v).replace(/\s+/g, "_")}`).join(" ");
}

export function parseRecord(text) {
  return Object.fromEntries(text.split(" ").map((part) => {
    const i = part.indexOf("=");
    return [part.slice(0, i), part.slice(i + 1)];
  }));
}

// Semantic recall narrows candidates; an exact key + network match decides. Returns newest matching failure.
export async function findFailure(memory, key, network) {
  const { results } = await memory.recall(`event=failure key=${key} network=${network}`, 10);
  return results
    .map((m) => parseRecord(m.text))
    .filter((r) => r.event === "failure" && r.key === key.replace(/\s+/g, "_") && r.network === network)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] ?? null;
}

export async function rememberEvent(memory, fields, { wait = true } = {}) {
  const text = formatRecord({ ...fields, at: new Date().toISOString() });
  return wait ? memory.rememberAndWait(text) : memory.remember(text);
}
