// What Edith keeps per wallet besides memory: spending limits and the activity people see.
// One JSON file per address, replaced atomically; writes for one address run one at a time, so two
// requests can never overwrite each other's changes. Amounts are MIST, stored as decimal strings.
// ponytail: files on one instance. Move to a database before running Edith on more than one machine.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { ADDRESS_RE } from "./auth.mjs";

export const DEFAULT_LIMITS = { perCallMist: "5000000", dailyMist: "20000000" }; // 0.005 SUI per call, 0.02 SUI a day
const ACTIVITY_KEPT = 200;
const DAY_MS = 24 * 60 * 60_000;

// Activity states that count against the daily limit: money that moved, is moving, or might have.
const SPENDING = new Set(["settling", "paid", "uncertain"]);

export function spentSince(user, sinceMs) {
  return user.activity
    .filter((a) => SPENDING.has(a.state) && Date.parse(a.at) >= sinceMs)
    .reduce((sum, a) => sum + BigInt(a.amountMist ?? 0), 0n);
}

export const spentToday = (user, now = Date.now()) => spentSince(user, now - DAY_MS);

export const newActivityId = () => randomBytes(9).toString("base64url");

// Returns a copy of `user` with the activity item `id` merged with `fields`, or added if new.
export function withActivity(user, id, fields) {
  const existing = user.activity.find((a) => a.id === id);
  const item = { ...existing, ...fields, id };
  const rest = user.activity.filter((a) => a.id !== id);
  return { ...user, activity: [item, ...rest].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ACTIVITY_KEPT) };
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
      return { address, createdAt: new Date().toISOString(), limits: DEFAULT_LIMITS, activity: [], agents: [] };
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
