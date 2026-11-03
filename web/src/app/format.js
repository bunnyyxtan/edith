// Display formatting: amounts, addresses, times and explorer links.

const MIST_PER_SUI = 1_000_000_000n;

// MIST (string or bigint) as a SUI amount with no trailing zeros: 1000000 -> "0.001".
export function sui(mist) {
  if (mist === null || mist === undefined || mist === "") return "–";
  const value = BigInt(mist);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const whole = abs / MIST_PER_SUI;
  const fraction = String(abs % MIST_PER_SUI).padStart(9, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

// At most four decimals, rounded down, for tight spaces: 5672856 MIST -> "0.0056". The full amount is shown elsewhere.
export function suiShort(mist) {
  const [whole, fraction = ""] = sui(mist).split(".");
  const kept = fraction.slice(0, 4).replace(/0+$/, "");
  return kept ? `${whole}.${kept}` : whole;
}

// A SUI amount typed by a person, as MIST. Returns null when it is not a positive amount.
export function toMist(text) {
  const match = /^\s*(\d{0,10})(?:\.(\d{0,9}))?\s*$/.exec(String(text));
  if (!match || (!match[1] && !match[2])) return null;
  const mist = BigInt(match[1] || "0") * MIST_PER_SUI + BigInt((match[2] ?? "").padEnd(9, "0") || "0");
  return mist > 0n ? mist : null;
}

export const shortAddress = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "");
export const shortId = (id) => (id ? `${id.slice(0, 6)}…${id.slice(-4)}` : "");

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS = [["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3600], ["minute", 60]];

export function ago(iso, now = Date.now()) {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  if (Number.isNaN(seconds)) return "";
  for (const [unit, size] of STEPS) if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  return "just now";
}

export const dateTime = (iso) => new Date(iso).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" });

export const txUrl = (network, digest) => `https://suiscan.xyz/${network}/tx/${digest}`;
export const accountUrl = (network, address) => `https://suiscan.xyz/${network}/account/${address}`;
export const blobUrl = (network, blobId) => `https://walruscan.com/${network}/blob/${blobId}`;

export function countdown(msLeft) {
  const s = Math.max(0, Math.ceil(msLeft / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
