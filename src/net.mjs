// Fetching provider URLs on a person's behalf without becoming a way into the server's own network.
// Addresses that resolve to loopback, private, link-local or other internal ranges are refused, and
// redirects are not followed. The bundled demo provider is reached directly, inside this process's host.
// DNS validation runs inside the socket's lookup: the connector uses exactly the checked addresses.
import { lookup as systemLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Provider replies are small JSON documents. Bound both the wire bytes and expanded data,
// independently of Content-Length, chunking, or a provider ignoring accept-encoding: identity.
export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export class ProviderResponseError extends Error {}

async function readProviderBody(res, headers) {
  const limit = MAX_PROVIDER_RESPONSE_BYTES;
  const length = headers.get("content-length");
  if (length && /^\d+$/.test(length) && BigInt(length) > BigInt(limit)) {
    throw new ProviderResponseError("Provider response exceeds the 1 MiB limit.");
  }
  const encoding = (headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[encoding];
  if (!decoder && encoding !== "identity") throw new ProviderResponseError("Unsupported provider response encoding.");
  let wireBytes = 0;
  let decodedBytes = 0;
  // One bounded allocation avoids retaining a Buffer object for every tiny attacker-controlled chunk.
  const output = Buffer.allocUnsafe(limit);
  const wireLimit = new Transform({ transform(chunk, encoding, done) {
    wireBytes += chunk.length;
    done(wireBytes > limit ? new ProviderResponseError("Provider response exceeds the 1 MiB wire limit.") : null, chunk);
  } });
  const collect = new Writable({ write(chunk, encoding, done) {
    if (decodedBytes + chunk.length > limit) return done(new ProviderResponseError("Provider response exceeds the 1 MiB decoded limit."));
    chunk.copy(output, decodedBytes);
    decodedBytes += chunk.length;
    done();
  } });
  // pipeline propagates errors/aborts and destroys the socket, decoder and collectors on overflow.
  await pipeline(res, wireLimit, ...(decoder ? [decoder()] : []), collect);
  if (decoder) { headers.delete("content-encoding"); headers.delete("content-length"); }
  return output.subarray(0, decodedBytes);
}

const internal = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]]) {
  internal.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]]) internal.addSubnet(net, prefix, "ipv6");

export class UnsafeUrlError extends Error {}

export function isInternalAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return internal.check(mapped, "ipv4");
  const family = isIP(address);
  return family === 0 || internal.check(address, family === 4 ? "ipv4" : "ipv6");
}

const hostnameOf = (url) => url.hostname.replace(/^\[|\]$/g, "");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
const isLoopback = (host) => Boolean(isIP(host)) && loopback.check(host, isIP(host) === 4 ? "ipv4" : "ipv6");
export const isLocalOrigin = (origin) => {
  const url = new URL(origin);
  return url.protocol === "http:" && (hostnameOf(url) === "localhost" || isLoopback(hostnameOf(url)));
};

const request = (url, options, callback) => (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, callback);

// demo: { origin, prefix, target } maps `${origin}${prefix}/...` URLs onto `target`, where the demo provider runs.
export function createProviderFetch({ demo, allowPrivate = false, timeoutMs = 20_000, lookup = systemLookup, transport = request } = {}) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new UnsafeUrlError("Use an HTTPS provider address without a username or password.");
    }
    let target = parsed;
    let localDemo = false;
    if (demo && parsed.origin === demo.origin && parsed.pathname.startsWith(`${demo.prefix}/`)) {
      target = new URL(parsed.pathname + parsed.search, demo.target);
      // Only the configured, literal loopback demo gets an internal HTTP exception.
      localDemo = target.protocol === "http:" && isLoopback(hostnameOf(target));
    }
    const host = hostnameOf(target);
    const localHttp = target.protocol === "http:" && (localDemo || (allowPrivate && isLocalOrigin(target.href)));
    if (target.protocol !== "https:" && !localHttp) throw new UnsafeUrlError("Providers must use HTTPS. HTTP is only allowed for the local development demo or explicit loopback development providers.");

    const check = (addresses) => {
      if (!addresses.length || addresses.some(({ address }) => !isIP(address)
        || (localHttp ? !isLoopback(address) : !allowPrivate && isInternalAddress(address)))) {
        throw new UnsafeUrlError("That address points inside a private network or outside the allowed local provider, so Edith won't call it.");
      }
      return addresses;
    };
    if (isIP(host)) check([{ address: host, family: isIP(host) }]);
    const checkedLookup = (name, options, callback) => {
      lookup(name, { all: true }).then(check).then((addresses) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      }).catch((err) => callback(err instanceof UnsafeUrlError ? err : new UnsafeUrlError("Edith couldn't find that address. Check the spelling.")));
    };

    // Native HTTP(S) keeps Host/SNI/certificate verification on the original hostname. No proxy,
    // automatic redirects, second DNS lookup, or cross-request socket reuse can bypass checkedLookup.
    return new Promise((resolve, reject) => {
      const headers = new Headers(init.headers);
      headers.set("accept-encoding", "identity");
      const req = transport(target, {
        method: init.method ?? "GET", headers: Object.fromEntries(headers), agent: false, maxHeaderSize: 16 * 1024,
        lookup: checkedLookup, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])]),
      }, async (res) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            for (const part of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(name, part);
          }
          const body = await readProviderBody(res, headers);
          resolve(new Response([204, 205, 304].includes(res.statusCode) || init.method === "HEAD" ? null : body, { status: res.statusCode, headers }));
        } catch (err) { res.destroy(); reject(err); }
      });
      req.on("error", reject);
      req.end(init.body);
    });
  };
}
