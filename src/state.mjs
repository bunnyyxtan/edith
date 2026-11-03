// Durable state in Postgres (Neon on Vercel): every wallet's record, pending approvals, the provider's replay
// ledger, spent sign-in nonces and rate-limit counters. Each money-critical step is one atomic statement or
// one row-locked transaction, so any number of function instances can serve Edith at once.
//
// `db` is { query(sql, params) -> { rows }, tx(fn(query)) }; pgDb wraps a pg Pool, pgliteDb an in-process PGlite.
// Times are passed in from the app clock, not taken from the database, so every instance agrees on expiry.
import { DEFAULT_LIMITS } from "./store.mjs";
import { ADDRESS_RE } from "./auth.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS edith_users (
  address text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS edith_plans (
  id text PRIMARY KEY, address text NOT NULL, planned jsonb NOT NULL, state text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS edith_used_digests (
  digest text PRIMARY KEY, state text NOT NULL, reserved_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS edith_nonces (
  nonce text PRIMARY KEY, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS edith_rate (
  key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
`;

const STALE_RESERVATION_MS = 6 * 60_000; // longer than a function may run (5 min); then a stuck reservation can be retried

export function pgDb(pool) {
  return {
    query: (sql, params) => pool.query(sql, params),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn((sql, params) => client.query(sql, params));
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

export function pgliteDb(pglite) {
  return {
    query: (sql, params) => pglite.query(sql, params),
    tx: (fn) => pglite.transaction((t) => fn((sql, params) => t.query(sql, params))),
  };
}

export async function migrate(db) {
  for (const statement of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(statement);
}

const at = (ms) => new Date(ms).toISOString();
const asJson = (value) => JSON.stringify(value);

// Same interface as the file store in store.mjs: read(address), update(address, change).
export function pgStore(db) {
  const fresh = (address) => ({ address, createdAt: new Date().toISOString(), limits: DEFAULT_LIMITS, activity: [], agents: [] });
  const check = (address) => {
    if (!ADDRESS_RE.test(address)) throw new Error("invalid address");
  };
  return {
    async read(address) {
      check(address);
      const { rows } = await db.query("SELECT data FROM edith_users WHERE address = $1", [address]);
      return rows[0]?.data ?? fresh(address);
    },
    // change(user) returns the new user, or throws to leave it untouched. The row is locked meanwhile, so
    // concurrent payments for one wallet are counted against its limits one at a time.
    update(address, change) {
      check(address);
      return db.tx(async (q) => {
        await q("INSERT INTO edith_users (address, data) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING", [address, asJson(fresh(address))]);
        const { rows } = await q("SELECT data FROM edith_users WHERE address = $1 FOR UPDATE", [address]);
        const next = change(rows[0].data);
        await q("UPDATE edith_users SET data = $2, updated_at = now() WHERE address = $1", [address, asJson(next)]);
        return next;
      });
    },
  };
}

// Pending approvals: the quote Edith got for a request, waiting for its owner's signature.
// take() claims a quote atomically, so a double submit, a second tab or a second instance cannot pay it twice.
export function pgPlans(db, now = () => Date.now()) {
  const toRow = ({ url, context, terms }) => asJson({ url, context, terms: { payTo: terms.payTo, amount: String(terms.amount), challenge: terms.challenge } });
  const fromRow = ({ url, context, terms }) => ({ url, context, terms: { ...terms, amount: BigInt(terms.amount) } });
  return {
    async put(id, address, planned, expiresAt) {
      await db.query("DELETE FROM edith_plans WHERE expires_at < $1", [at(now() - 60 * 60_000)]);
      await db.query(
        `INSERT INTO edith_plans (id, address, planned, state, expires_at) VALUES ($1, $2, $3, 'ready', $4)
         ON CONFLICT (id) DO UPDATE SET planned = EXCLUDED.planned, state = 'ready', expires_at = EXCLUDED.expires_at
         WHERE edith_plans.state = 'ready' AND edith_plans.address = EXCLUDED.address`,
        [id, address, toRow(planned), at(expiresAt)]);
    },
    // { planned } once claimed, or { reason: "missing" | "expired" | "busy" }.
    async take(id, address) {
      const { rows } = await db.query(
        "UPDATE edith_plans SET state = 'paying' WHERE id = $1 AND address = $2 AND state = 'ready' AND expires_at > $3 RETURNING planned",
        [id, address, at(now())]);
      if (rows.length) return { planned: fromRow(rows[0].planned) };
      const { rows: [row] } = await db.query("SELECT state, expires_at FROM edith_plans WHERE id = $1 AND address = $2", [id, address]);
      if (!row) return { reason: "missing" };
      if (row.state === "paying") return { reason: "busy" };
      await db.query("DELETE FROM edith_plans WHERE id = $1 AND state = 'ready'", [id]);
      return { reason: "expired" };
    },
    release: (id) => db.query("UPDATE edith_plans SET state = 'ready' WHERE id = $1 AND state = 'paying'", [id]),
    drop: (id) => db.query("DELETE FROM edith_plans WHERE id = $1", [id]),
    // Withdraws a quote nobody is paying. Returns false when it is being paid right now.
    async cancel(id, address) {
      await db.query("DELETE FROM edith_plans WHERE id = $1 AND address = $2 AND state = 'ready'", [id, address]);
      const { rows } = await db.query("SELECT state FROM edith_plans WHERE id = $1 AND address = $2", [id, address]);
      return rows[0]?.state !== "paying";
    },
  };
}

// The provider's replay ledger: a digest is reserved before settlement and committed once paid for.
export function pgLedger(db, now = () => Date.now()) {
  return {
    async reserve(digest) {
      const { rows } = await db.query(
        `INSERT INTO edith_used_digests (digest, state, reserved_at) VALUES ($1, 'pending', $2)
         ON CONFLICT (digest) DO UPDATE SET reserved_at = EXCLUDED.reserved_at
         WHERE edith_used_digests.state = 'pending' AND edith_used_digests.reserved_at < $3
         RETURNING digest`,
        [digest, at(now()), at(now() - STALE_RESERVATION_MS)]);
      return rows.length === 1;
    },
    commit: (digest) => db.query("UPDATE edith_used_digests SET state = 'used' WHERE digest = $1", [digest]),
    release: (digest) => db.query("DELETE FROM edith_used_digests WHERE digest = $1 AND state = 'pending'", [digest]),
  };
}

// Each sign-in message works once. Returns false if this nonce was already spent.
export function pgNonces(db, now = () => Date.now()) {
  return async (nonce, expiresAtMs) => {
    await db.query("DELETE FROM edith_nonces WHERE expires_at < $1", [at(now())]);
    const { rows } = await db.query("INSERT INTO edith_nonces (nonce, expires_at) VALUES ($1, $2) ON CONFLICT (nonce) DO NOTHING RETURNING nonce", [nonce, at(expiresAtMs)]);
    return rows.length === 1;
  };
}

// Fixed-window counters shared by every instance. Returns async (key) -> allowed.
export function pgLimiter(db, name, { limit, windowMs }, now = () => Date.now()) {
  return async (key) => {
    const window = Math.floor(now() / windowMs);
    const { rows } = await db.query(
      `INSERT INTO edith_rate (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE SET count = edith_rate.count + 1 RETURNING count`,
      [`${name}:${key}:${window}`, at(window * windowMs)]);
    if (Math.random() < 0.01) await db.query("DELETE FROM edith_rate WHERE window_start < $1", [at(now() - 24 * 60 * 60_000)]);
    return rows[0].count <= limit;
  };
}

// The same pieces in memory, for tests and a single local process.
export function memoryPlans(now = () => Date.now()) {
  const plans = new Map();
  return {
    async put(id, address, planned, expiresAt) {
      const existing = plans.get(id);
      if (existing && (existing.state !== "ready" || existing.address !== address)) return;
      plans.set(id, { planned, address, state: "ready", expires: expiresAt });
    },
    async take(id, address) {
      const entry = plans.get(id);
      if (!entry || entry.address !== address) return { reason: "missing" };
      if (entry.state === "paying") return { reason: "busy" };
      if (entry.expires <= now()) {
        plans.delete(id);
        return { reason: "expired" };
      }
      entry.state = "paying";
      return { planned: entry.planned };
    },
    async release(id) {
      const entry = plans.get(id);
      if (entry?.state === "paying") entry.state = "ready";
    },
    async drop(id) {
      plans.delete(id);
    },
    async cancel(id, address) {
      const entry = plans.get(id);
      if (entry?.address === address && entry.state === "ready") plans.delete(id);
      return plans.get(id)?.state !== "paying";
    },
  };
}
