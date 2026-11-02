// Pure decision logic: given what Edith remembers about an endpoint, should it pay for this request?

export const POLICY = {
  transientCooldownMs: 15 * 60_000, // retry a request that failed with 5xx/429 after this long
  unreliableMinFailures: 3, // an endpoint needs at least this many paid failures to be judged unreliable
  unreliableFailureRate: 0.5, // and a failure rate strictly above this
  priceSpikeFactor: 2n, // refuse prices above this multiple of the highest price that previously paid off
};

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

// Classifies a paid response. Returns null when the response was worth paying for.
export function classifyResponse(status, body, isUseful) {
  if (status === 200 && isUseful(body)) return null;
  if (status === 200) return { kind: "bad_payload", reason: "empty or malformed payload" };
  const reason = `HTTP ${status}${body?.error ? ` ${body.error}` : ""}`;
  return { kind: TRANSIENT_STATUS.has(status) ? "transient" : "rejected", reason };
}

// history: normalized outcome records for this provider, endpoint and network.
export function decide(history, { key, price, now }) {
  const oldestFirst = [...history].sort((a, b) => a.at.localeCompare(b.at));

  const lastExact = oldestFirst.findLast((r) => r.key === key);
  if (lastExact?.result === "failure") {
    const ageMs = now - Date.parse(lastExact.at);
    if (lastExact.kind !== "transient") {
      return skip(`this exact request failed before (${lastExact.reason}, tx ${lastExact.digest})`, lastExact);
    }
    if (ageMs < POLICY.transientCooldownMs) {
      return skip(`transient failure ${Math.round(ageMs / 60_000)} min ago (${lastExact.reason}); cooling down`, lastExact);
    }
  }

  // Reliability is judged per distinct request (its latest outcome), so retries of one request do not
  // condemn the endpoint. Only junk and rejections count: a 5xx says the provider was unavailable,
  // not that it sells bad data, and counting it would block the retries that prove recovery.
  const latest = [...new Map(oldestFirst.map((r) => [r.key, r])).values()];
  const broken = latest.filter((r) => r.result === "failure" && r.kind !== "transient").length;
  if (lastExact?.result !== "success" && broken >= POLICY.unreliableMinFailures && broken / latest.length > POLICY.unreliableFailureRate) {
    return skip(`endpoint unreliable: ${broken} of ${latest.length} distinct paid requests returned junk or were rejected`);
  }

  const bestPaid = history.filter((r) => r.result === "success").reduce((max, r) => (r.paid > max ? r.paid : max), 0n);
  if (price !== undefined && bestPaid > 0n && price > bestPaid * POLICY.priceSpikeFactor) {
    return skip(`price ${price} MIST is over ${POLICY.priceSpikeFactor}x the ${bestPaid} MIST that paid off before`);
  }

  const ok = latest.filter((r) => r.result === "success").length;
  const note = lastExact?.result === "failure" ? "transient failure cooled down, retrying" : `endpoint record: ${ok} requests ok, ${latest.length - ok} failed`;
  return { action: "pay", reason: note };
}

function skip(reason, record) {
  return { action: "skip", reason, saved: record?.paid };
}
