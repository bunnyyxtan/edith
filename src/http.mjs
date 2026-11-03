// Small HTTP helpers for the web API: JSON in and out, streamed progress, cookies, static files,
// security headers and rate limits.
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const MAX_BODY_BYTES = 32_768; // a signed transaction from a zkLogin wallet is a few KB
const CONTENT_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const json = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

// Wallet icons are data URIs; everything else comes from this origin.
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export function securityHeaders(res, secure) {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "same-origin");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
}

export function send(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(json(body));
}

export function openStream(res) {
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" });
  return (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${json(event)}\n`);
  };
}

// Only same-origin JSON requests may trigger work: a cross-site form cannot send this content type,
// and the session cookie is SameSite=Strict besides.
export async function readJson(req) {
  if (!req.headers["content-type"]?.startsWith("application/json")) throw new HttpError(415, "Expected a JSON request.");
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, "Requests must come from the Edith app.");
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "Request too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookieHeader(name, value, { maxAgeMs, secure }) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

// Fixed-window counter per key. ponytail: in memory on one instance; use a shared store when scaling out.
export function createLimiter({ limit, windowMs }) {
  const windows = new Map();
  return (key) => {
    const now = Date.now();
    if (windows.size > 10_000) for (const [k, w] of windows) if (w.reset < now) windows.delete(k);
    const current = windows.get(key);
    if (!current || current.reset < now) {
      windows.set(key, { count: 1, reset: now + windowMs });
      return true;
    }
    current.count += 1;
    return current.count <= limit;
  };
}

// Page routes resolve to their section's own index.html (/app/... -> app/index.html), else the site's.
export async function serveStatic(res, staticDir, pathname) {
  if (!staticDir) return send(res, 404, { error: "Not found." });
  const root = resolve(staticDir);
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, { error: "Bad path." });
  }
  const file = resolve(root, `.${decoded}`);
  const section = join(root, decoded.split("/")[1] ?? "", "index.html");
  const page = section.startsWith(root + sep) && (await stat(section).catch(() => null))?.isFile() ? section : join(root, "index.html");
  const target = file.startsWith(root + sep) && extname(file) ? file : page;
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(target)] ?? "application/octet-stream", "cache-control": target.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(body);
  } catch {
    send(res, 404, { error: "Not found." });
  }
}
