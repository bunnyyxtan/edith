// Vercel function: every /api, /v1 and /demo request (see vercel.json). The static site and app are served
// from web/dist by Vercel directly. All state lives in Neon Postgres, so any instance can take any request.
import { buildHandler } from "../src/app.mjs";

let ready = null; // built once per instance, reused across invocations

export default async function edith(req, res) {
  ready ??= buildHandler(process.env).catch((err) => {
    ready = null; // a later request retries, e.g. after the database wakes up
    throw err;
  });
  let handler;
  try {
    handler = await ready;
  } catch (err) {
    console.error("Edith failed to start:", err.message);
    res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ error: "Edith is starting up or misconfigured. Try again in a moment." }));
  }
  // The rewrite passes the original path; restore it so Edith routes the request as it was made.
  const url = new URL(req.url, "http://edith");
  const path = url.searchParams.get("__path");
  if (path) {
    url.searchParams.delete("__path");
    req.url = `${path}${url.search}`;
  }
  return handler(req, res);
}
