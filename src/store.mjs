// What Edith keeps per wallet besides memory: spending limits and the activity people see.
// One JSON file per address, replaced atomically; writes for one address run one at a time, so two
// requests can never overwrite each other's changes. Amounts are MIST, stored as decimal strings.
// ponytail: files on one instance. Move to a database before running Edith on more than one machine.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ADDRESS_RE } from "./auth.mjs";

export const DEFAULT_LIMITS = { perCallMist: "5000000", dailyMist: "20000000" }; // 0.005 SUI per call, 0.02 SUI a day
// Only records created by the guarded writer start with a complete history. Existing records
// require an evidence-backed operator reconciliation; an empty display history proves nothing.
export const freshUser = (address) => ({ address, createdAt: new Date().toISOString(), limits: DEFAULT_LIMITS,
  activity: [], agents: [], paymentHistory: { version: 1, basis: "created-with-guards" } });
export const paymentHistoryReady = (user) => user.paymentHistory?.version === 1 &&
  (user.paymentHistory.basis === "created-with-guards" ||
    (user.paymentHistory.basis === "reconciled" && Boolean(user.paymentHistory.evidenceRef) && Boolean(user.paymentHistory.reviewedAt)));
const ACTIVITY_KEPT = 200;
const DAY_MS = 24 * 60 * 60_000;

// Activity states that count against the daily limit: money that moved, is moving, or might have.
const SPENDING = new Set(["settling", "paid", "uncertain"]);
const pending = (item) => item.state === "settling" || item.state === "uncertain";

// Older versions called an unobserved, handed-off signature "refused". It can still land.
const paymentState = (item) => item.state === "refused" && item.digest && !item.chainFailed && !item.invalidationProof
  ? { ...item, state: "uncertain", error: "This signed payment may still settle. Check Sui before paying again." }
  : item;
const paymentTime = (item) => Date.parse(item.verifiedAt ?? item.settlingAt ?? item.at);
// Existing JSON/JSONB records migrate lazily, inside the same atomic wallet update.
const payments = (user) => user.spending ?? user.activity.map(paymentState).filter((a) => SPENDING.has(a.state));

export function spentSince(user, sinceMs) {
  return payments(user)
    .filter((a) => pending(a) || (a.state === "paid" && paymentTime(a) >= sinceMs))
    .reduce((sum, a) => sum + BigInt(a.amountMist ?? 0), 0n);
}

export const spentToday = (user, now = Date.now()) => spentSince(user, now - DAY_MS);

export const newActivityId = () => randomBytes(9).toString("base64url");

// Returns a copy of `user` with the activity item `id` merged with `fields`, or added if new.
export function withActivity(user, id, fields, now = Date.now()) {
  const history = user.activity.map(paymentState);
  const existing = history.find((a) => a.id === id) ?? payments(user).find((a) => a.id === id);
  const item = { ...existing, ...fields, id };
  const rest = history.filter((a) => a.id !== id);
  const spending = payments(user).filter((a) => a.id !== id);
  if (SPENDING.has(item.state)) spending.push(item);
  return {
    ...user,
    // Keep unresolved payments and the just-updated result visible for reconciliation/review.
    activity: [item, ...rest].sort((a, b) => b.at.localeCompare(a.at)).filter((a, i) => i < ACTIVITY_KEPT || pending(a) || a.id === id),
    spending: spending.filter((a) => pending(a) || paymentTime(a) >= now - DAY_MS),
  };
}

export function createStore(dir) {
  const queues = new Map();

  const fileFor = (address) => {
    if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
    return join(dir, `${address}.json`);
  };

  async function read(address) {
    try {
      return JSON.parse(await readFile(fileFor(address), "utf8"));
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      return freshUser(address);
    }
  }

  // change(user) returns the new user, or throws to leave it untouched. Resolves to what was saved.
  function update(address, change) {
    const run = (queues.get(address) ?? Promise.resolve()).then(async () => {
      const next = change(await read(address));
      const file = fileFor(address);
      const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      await mkdir(dir, { recursive: true });
      await writeFile(temp, JSON.stringify(next, null, 2));
      await rename(temp, file);
      return next;
    });
    queues.set(address, run.catch(() => {}));
    return run;
  }

  return { read, update };
}
