// Edith's long-term memory of paid requests, stored in Walrus Memory.
// Records are single-line key=value text: semantic recall finds candidates, exact fields decide.
import { MemWal } from "@mysten-incubation/memwal";

export const NAMESPACE = "edith";
const RECALL_LIMIT = 100; // ceiling on history per endpoint; summarize older outcomes if endpoints outgrow it

export function createMemory(env = process.env) {
  if (!env.MEMWAL_PRIVATE_KEY || !env.MEMWAL_ACCOUNT_ID) throw new Error("MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID are required");
  return MemWal.create({
    key: env.MEMWAL_PRIVATE_KEY,
    accountId: env.MEMWAL_ACCOUNT_ID,
    serverUrl: env.MEMWAL_SERVER_URL,
    namespace: NAMESPACE,
  });
}

const token = (value) => String(value).replace(/\s+/g, "_");

// Identity of a request: method, path and sorted query. Host is tracked separately as the provider.
export function describeRequest(method, url) {
  const u = new URL(url);
  u.searchParams.sort();
  const m = method.toUpperCase();
  return { key: token(`${m} ${u.pathname}${u.search}`), endpoint: token(`${m} ${u.pathname}`), provider: u.host };
}

export function formatRecord(fields) {
  return Object.entries(fields).map(([k, v]) => `${k}=${token(v)}`).join(" ");
}

export function parseRecord(text) {
  return Object.fromEntries(text.split(" ").map((part) => {
    const i = part.indexOf("=");
    return [part.slice(0, i), part.slice(i + 1)];
  }));
}

// Maps stored records to outcomes. Records written before outcome tracking (event=failure) are
// kept: they carry no endpoint or provider, so those are derived from the key or left open.
export function toOutcome(record) {
  if (record.event === "outcome") return { ...record, paid: BigInt(record.paid ?? 0) };
  if (record.event !== "failure" || !record.key) return null;
  return {
    ...record,
    result: "failure",
    kind: /^HTTP_5\d\d/.test(record.reason ?? "") ? "transient" : "bad_payload",
    endpoint: record.key.split("?")[0],
    paid: BigInt(record.paid ?? 0),
  };
}

// All remembered outcomes for one endpoint at one provider on one network.
export async function loadHistory(memory, { endpoint, provider, network }) {
  const { results } = await memory.recall(`event=outcome endpoint=${endpoint} provider=${provider} network=${network}`, RECALL_LIMIT);
  return results
    .map((m) => toOutcome(parseRecord(m.text)))
    .filter((r) => r && r.endpoint === endpoint && r.network === network && (!r.provider || r.provider === provider));
}

export async function rememberEvent(memory, fields, { wait = true } = {}) {
  const text = formatRecord({ ...fields, at: new Date().toISOString() });
  return wait ? memory.rememberAndWait(text) : memory.remember(text);
}
