// An agent's own expectations of a paid answer, checked after payment like any other judgement.
// Edith cannot know whether data is true; the agent knows what a sane answer looks like for its task.
//   expect: { "<dot.path>": { type?, min?, max?, equals?, maxAgeSec? } }   every listed field is required
// A broken rule is remembered as an inaccurate answer; data older than maxAgeSec is only stale, so it cools down.

const MAX_RULES = 10;
const PATH_RE = /^[A-Za-z0-9_-]{1,40}(?:\.[A-Za-z0-9_-]{1,40}){0,4}$/;
const TYPES = new Set(["number", "string", "boolean"]);
const MAX_AGE_SEC = 7 * 24 * 60 * 60;

export class ExpectError extends Error {}

const finite = (value, name, path) => {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ExpectError(`expect.${path}.${name} must be a number.`);
  return value;
};

// Validates untrusted rules and returns a clean copy, or null when there are none.
export function parseExpect(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new ExpectError("expect must be an object of field rules.");
  const entries = Object.entries(raw);
  if (entries.length === 0) return null;
  if (entries.length > MAX_RULES) throw new ExpectError(`expect can hold at most ${MAX_RULES} rules.`);
  const rules = {};
  for (const [path, rule] of entries) {
    if (!PATH_RE.test(path)) throw new ExpectError(`expect field "${path.slice(0, 60)}" is not a valid dot path.`);
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new ExpectError(`expect.${path} must be an object.`);
    const unknown = Object.keys(rule).find((k) => !["type", "min", "max", "equals", "maxAgeSec"].includes(k));
    if (unknown) throw new ExpectError(`expect.${path}.${unknown} is not a supported rule.`);
    const clean = {};
    if (rule.type !== undefined) {
      if (!TYPES.has(rule.type)) throw new ExpectError(`expect.${path}.type must be number, string or boolean.`);
      clean.type = rule.type;
    }
    if (rule.min !== undefined) clean.min = finite(rule.min, "min", path);
    if (rule.max !== undefined) clean.max = finite(rule.max, "max", path);
    if (clean.min !== undefined && clean.max !== undefined && clean.min > clean.max) throw new ExpectError(`expect.${path}.min is above its max.`);
    if (rule.equals !== undefined) {
      if (!["string", "number", "boolean"].includes(typeof rule.equals) || String(rule.equals).length > 200) {
        throw new ExpectError(`expect.${path}.equals must be a short string, number or boolean.`);
      }
      clean.equals = rule.equals;
    }
    if (rule.maxAgeSec !== undefined) {
      const age = finite(rule.maxAgeSec, "maxAgeSec", path);
      if (age <= 0 || age > MAX_AGE_SEC) throw new ExpectError(`expect.${path}.maxAgeSec must be between 1 and ${MAX_AGE_SEC}.`);
      clean.maxAgeSec = age;
    }
    rules[path] = clean;
  }
  return rules;
}

function lookup(body, path) {
  let value = body;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return { found: false };
    value = value[part];
  }
  return { found: true, value };
}

const show = (value) => JSON.stringify(value)?.slice(0, 60);

// null when the answer meets every rule; otherwise the first broken rule as a remembered problem.
export function checkExpect(body, rules, now = Date.now()) {
  if (!rules) return null;
  const wrong = (reason) => ({ kind: "inaccurate", reason: `expectation failed: ${reason}` });
  for (const [path, rule] of Object.entries(rules)) {
    const { found, value } = lookup(body, path);
    if (!found || value === null) return wrong(`${path} is missing`);
    if (rule.type && typeof value !== rule.type) return wrong(`${path} is ${typeof value}, expected ${rule.type}`);
    if ((rule.min !== undefined || rule.max !== undefined) && typeof value !== "number") return wrong(`${path} is not a number`);
    if (rule.min !== undefined && value < rule.min) return wrong(`${path} ${show(value)} is below ${rule.min}`);
    if (rule.max !== undefined && value > rule.max) return wrong(`${path} ${show(value)} is above ${rule.max}`);
    if (rule.equals !== undefined && value !== rule.equals) return wrong(`${path} is ${show(value)}, expected ${show(rule.equals)}`);
    if (rule.maxAgeSec !== undefined) {
      const at = typeof value === "number" ? value : Date.parse(value);
      if (!Number.isFinite(at)) return wrong(`${path} is not a timestamp`);
      const ageSec = Math.round((now - at) / 1000);
      if (ageSec > rule.maxAgeSec) return { kind: "transient", reason: `stale: ${path} is ${ageSec}s old, over ${rule.maxAgeSec}s` };
    }
  }
  return null;
}

// The provider's own freshness promise for an answer, in seconds, or 0 when it may not be reused.
export function cacheSeconds(cacheControl) {
  const value = String(cacheControl ?? "").toLowerCase();
  if (/no-store|no-cache/.test(value)) return 0;
  const match = /(?:^|[,\s])max-age=(\d{1,7})/.exec(value);
  return match ? Number(match[1]) : 0;
}
