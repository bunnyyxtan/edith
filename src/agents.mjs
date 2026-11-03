// Agent keys. An agent key lets software ask Edith about paid requests on a wallet's behalf: Edith
// recalls, judges and quotes, and refuses on its own when memory or limits say so. A key can never pay.
// Every payment it asks for waits for the wallet's owner to approve and sign it in the app.
//
// Token: ek_<owner address hex>.<agent id>.<secret>. The address is public on chain anyway; it tells the
// server whose file holds the agent, so no global key index is needed. Only a hash of the secret is kept.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const MAX_AGENTS = 10;
const TOKEN_RE = /^ek_([0-9a-f]{64})\.([A-Za-z0-9_-]{12})\.([A-Za-z0-9_-]{43})$/;
const NAME_RE = /^[\p{L}\p{N} ._'()-]{1,40}$/u;

const digest = (secret) => createHash("sha256").update(secret).digest();

export function validAgentName(name) {
  const trimmed = String(name ?? "").trim().replace(/\s+/g, " ");
  return NAME_RE.test(trimmed) ? trimmed : null;
}

// Returns the stored agent and the one-time token to hand to the person.
export function newAgent(address, name, now = Date.now()) {
  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const agent = { id, name, secretHash: digest(secret).toString("base64url"), createdAt: new Date(now).toISOString(), lastUsedAt: null, revokedAt: null };
  return { agent, token: `ek_${address.slice(2)}.${id}.${secret}` };
}

// { address, id, secret } from an Authorization header, or null.
export function parseAgentToken(header) {
  const match = /^Bearer (\S+)$/.exec(String(header ?? ""));
  const parts = match && TOKEN_RE.exec(match[1]);
  return parts ? { address: `0x${parts[1]}`, id: parts[2], secret: parts[3] } : null;
}

// The live agent in `user` that this secret belongs to, or null.
export function matchAgent(user, id, secret) {
  const agent = (user.agents ?? []).find((a) => a.id === id && !a.revokedAt);
  if (!agent) return null;
  const expected = Buffer.from(agent.secretHash, "base64url");
  return timingSafeEqual(expected, digest(secret)) ? agent : null;
}

export const publicAgent = ({ secretHash, ...agent }) => agent;
