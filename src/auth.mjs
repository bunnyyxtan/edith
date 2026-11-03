// Wallet sign-in and sessions. The wallet proves the address once by signing a short, expiring message;
// an HMAC-sealed cookie carries the address after that. Signing in grants no spending power: every
// payment is a separate transaction the wallet has to sign.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

export const SESSION_COOKIE = "edith_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const SIGN_IN_TTL_MS = 5 * 60_000;
export const ADDRESS_RE = /^0x[0-9a-f]{64}$/;

export class AuthError extends Error {}

// Each sign-in message works once; this in-memory record serves a single process (tests, local runs).
function memoryNonces(now) {
  const spent = new Map();
  return async (nonce, expiresAtMs) => {
    for (const [n, exp] of spent) if (exp < now()) spent.delete(n);
    if (spent.has(nonce)) return false;
    spent.set(nonce, expiresAtMs);
    return true;
  };
}

const mac = (secret, payload) => createHmac("sha256", secret).update(payload).digest("base64url");

// Sealed tokens carry a kind, so a sign-in nonce can never pass for a session or the reverse.
function seal(secret, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(secret, payload)}`;
}

function unseal(secret, token, kind, now) {
  const [payload, signature, extra] = String(token).split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  return claims.k === kind && now <= claims.exp && ADDRESS_RE.test(claims.a) ? claims : null;
}

// client: a Sui client, needed to verify zkLogin and passkey wallets' signatures.
// spendNonce(nonce, expiresAtMs) -> false if already spent; durable (state.mjs) when deployed.
export function createAuth({ secret, origin, network, client, now = Date.now, spendNonce = memoryNonces(now) }) {
  const host = new URL(origin).host;

  const render = ({ a, iat, exp }, nonce) => [
    `${host} wants you to sign in with your Sui account:`,
    a,
    "",
    "Sign in to Edith. This proves you own this address. It does not move funds or let Edith spend for you.",
    "",
    `URI: ${origin}`,
    `Network: sui:${network}`,
    `Nonce: ${nonce}`,
    `Issued At: ${new Date(iat).toISOString()}`,
    `Expiration Time: ${new Date(exp).toISOString()}`,
  ].join("\n");

  function signInMessage(address) {
    if (!ADDRESS_RE.test(address ?? "")) throw new AuthError("That isn't a Sui address.");
    const iat = now();
    const claims = { k: "sign-in", a: address, iat, exp: iat + SIGN_IN_TTL_MS, n: randomBytes(9).toString("base64url") };
    return render(claims, seal(secret, claims));
  }

  // Returns the session cookie value for the address that signed `message`.
  async function signIn(message, signature) {
    const nonce = /^Nonce: (\S+)$/m.exec(String(message ?? ""))?.[1];
    const claims = nonce && unseal(secret, nonce, "sign-in", now());
    if (!claims) throw new AuthError("This sign-in request expired. Connect again to get a fresh one.");
    if (render(claims, nonce) !== message) throw new AuthError("The signed message doesn't match the sign-in request.");
    try {
      await verifyPersonalMessageSignature(new TextEncoder().encode(message), String(signature ?? ""), { address: claims.a, client });
    } catch {
      throw new AuthError("Your wallet's signature couldn't be verified for this address.");
    }
    // Spent only after the signature checks out, and atomically: a second use of this message fails here.
    if (!(await spendNonce(nonce, claims.exp))) throw new AuthError("This sign-in request was already used. Connect again.");
    return { address: claims.a, cookie: seal(secret, { k: "session", a: claims.a, exp: now() + SESSION_TTL_MS }) };
  }

  // The signed-in address for a session cookie value, or null.
  const session = (cookie) => (cookie ? unseal(secret, cookie, "session", now())?.a ?? null : null);

  return { signInMessage, signIn, session };
}
