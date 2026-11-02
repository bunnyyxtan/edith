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
export function decide(history, { key, price, now }, policy = POLICY) {
  const newestFirst = [...history].sort((a, b) => b.at.localeCompare(a.at));

  const lastExact = newestFirst.find((r) => r.key === key);
  if (lastExact?.result === "failure") {
    const ageMs = now - Date.parse(lastExact.at);
    if (lastExact.kind !== "transient") {
      return skip(`this exact request failed before (${lastExact.reason}, tx ${lastExact.digest})`, lastExact);
    }
    if (ageMs < policy.transientCooldownMs) {
      return skip(`transient failure ${Math.round(ageMs / 60_000)} min ago (${lastExact.reason}); cooling down`, lastExact);
    }
  }

  // Reliability is judged per distinct request (its latest outcome), so retries of one bad request
  // do not condemn the endpoint. A request that last succeeded stays payable regardless.
  const latestPerKey = [...new Map(newestFirst.toReversed().map((r) => [r.key, r])).values()];
  const failures = latestPerKey.filter((r) => r.result === "failure").length;
  const total = latestPerKey.length;
  if (lastExact?.result !== "success" && failures >= policy.unreliableMinFailures && failures / total > policy.unreliableFailureRate) {
    return skip(`endpoint unreliable: ${failures} of ${total} distinct paid requests failed`);
  }

  const bestPaid = history.filter((r) => r.result === "success").reduce((max, r) => (r.paid > max ? r.paid : max), 0n);
  if (price !== undefined && bestPaid > 0n && price > bestPaid * policy.priceSpikeFactor) {
    return skip(`price ${price} MIST is over ${policy.priceSpikeFactor}x the ${bestPaid} MIST that paid off before`);
  }

  const note = lastExact?.result === "failure" ? "transient failure cooled down, retrying" : `endpoint record: ${total - failures} requests ok, ${failures} failed`;
  return { action: "pay", reason: note };
}

function skip(reason, record) {
  return { action: "skip", reason, saved: record?.paid };
}
