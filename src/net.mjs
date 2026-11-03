// Fetching provider URLs on a person's behalf without becoming a way into the server's own network.
// Addresses that resolve to loopback, private, link-local or other internal ranges are refused, and
// redirects are not followed. The bundled demo provider is reached directly, inside this process's host.
// ponytail: the address is checked, then fetched, so DNS that changes in between (rebinding) is not
// covered. Pin the resolved address with a custom dispatcher if Edith ever runs next to sensitive services.
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

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

async function assertPublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => {
    throw new UnsafeUrlError("Edith couldn't find that address. Check the spelling.");
  });
  if (addresses.some(({ address }) => isInternalAddress(address))) {
    throw new UnsafeUrlError("That address points inside a private network, so Edith won't call it.");
  }
}

// demo: { origin, prefix, target } maps `${origin}${prefix}/...` URLs onto `target`, where the demo provider runs.
export function createProviderFetch({ demo, allowPrivate = false, timeoutMs = 20_000, fetch = globalThis.fetch }) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    let target = parsed;
    if (demo && parsed.origin === demo.origin && parsed.pathname.startsWith(`${demo.prefix}/`)) {
      target = new URL(parsed.pathname + parsed.search, demo.target);
    } else if (!allowPrivate) {
      await assertPublic(parsed.hostname);
    }
    return fetch(target, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  };
}
