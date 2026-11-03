// How an activity item reads to a person: one word, one headline, one plain explanation, and the
// on-chain and in-memory evidence behind it. Used by the run screen and the activity details alike.
import { h, icon, link } from "./dom.js";
import { blobUrl, dateTime, shortId, sui, txUrl } from "./format.js";

const PROBLEM = {
  bad_payload: "returned an empty or broken answer",
  rejected: "refused the request after taking payment",
  transient: "had a temporary problem",
};

export function problemText(problem) {
  if (!problem) return "";
  const base = PROBLEM[problem.kind] ?? "didn't deliver";
  return problem.kind === "bad_payload" || !problem.reason ? base : `${base} (${problem.reason})`;
}

// A remembered failure reason, as people say it.
export function plainReason(reason) {
  if (/empty or malformed payload/.test(reason ?? "")) return "an empty or broken answer";
  if (/paid, but the provider never answered/.test(reason ?? "")) return "no answer at all";
  return reason ? `an error (${reason})` : "nothing useful";
}

// The remembered paid outcome behind a memory decision, as a sentence.
function basisText(basis) {
  if (!basis) return null;
  const when = basis.at ? dateTime(basis.at) : "earlier";
  const what = basis.result === "failure" ? `got ${plainReason(basis.reason)}` : "got a useful answer";
  return `On ${when} you paid ${sui(basis.paidMist)} SUI for this exact request and ${what}.`;
}

export function story(item) {
  const amount = item.amountMist ? `${sui(item.amountMist)} SUI` : "";
  switch (item.state) {
    case "awaiting":
      return {
        word: "APPROVE?", tone: "wait", title: "Waiting for your approval",
        text: `${item.source?.kind === "agent" ? `${item.source.name} wants to pay` : "Edith would pay"} ${amount} to ${item.provider}. Memory and your limits allow it (${item.decision?.reason ?? "nothing argues against it"}). Nothing is paid until you approve in your wallet.`,
      };
    case "blocked":
      if (item.decision?.source === "limit") {
        return { word: "HELD.", tone: "hold", title: "Over your spending limits", text: `Edith didn't pay: ${item.decision.reason}. Nothing was paid.` };
      }
      return {
        word: "REFUSED.", tone: "hold", title: "Edith refused to pay for this again",
        text: `${basisText(item.decision?.basis) ?? `Edith's memory: ${item.decision?.reason}.`} Edith declined before contacting the provider. Nothing was paid.`,
      };
    case "free":
      return { word: "FREE.", tone: "good", title: "No payment needed", text: `The provider answered without asking to be paid (HTTP ${item.status}).` };
    case "settling":
      return { word: "SENDING", tone: "wait", title: "Settling on Sui", text: "Your signed payment is with the provider. Edith is confirming it on Sui." };
    case "paid":
      if (item.result === "failure") {
        return {
          word: "REMEMBERED.", tone: "hold", title: "Paid for nothing. Remembered.",
          text: `You paid ${amount} and the provider ${problemText(item.problem)}. ${item.problem?.kind === "transient" ? "Edith will wait 15 minutes before paying for it again." : "Edith will refuse to pay for this request again."}`,
        };
      }
      return { word: "PAID.", tone: "good", title: "Paid, and worth it", text: `You paid ${amount} and got a useful answer. Edith remembers this provider delivered.` };
    case "uncertain":
      return { word: "UNSURE", tone: "wait", title: "Waiting to see it on Sui", text: item.error ?? "Edith couldn't confirm this payment yet." };
    case "refused":
      return { word: "NOT PAID", tone: "hold", title: "The provider refused the payment", text: item.error ?? "Nothing was paid." };
    case "failed":
      return { word: "NOT PAID", tone: "hold", title: "This payment didn't go through", text: item.error ?? "Nothing was paid." };
    case "cancelled":
      return { word: "DECLINED", tone: "muted", title: "You declined this payment", text: "Nothing was paid." };
    case "expired":
      return { word: "EXPIRED", tone: "muted", title: "This quote expired", text: "Quotes last four minutes. Nothing was paid. Ask again for a fresh price." };
    default:
      return { word: "–", tone: "muted", title: item.state, text: "" };
  }
}

// Short label for lists.
export const LABEL = {
  awaiting: "Needs approval", blocked: "Refused", free: "Free", settling: "Settling", paid: "Paid",
  uncertain: "Unconfirmed", refused: "Not paid", failed: "Not paid", cancelled: "Declined", expired: "Expired",
};

export function label(item) {
  if (item.state === "blocked") return item.decision?.source === "limit" ? "Held by limit" : "Refused by memory";
  if (item.state === "paid") return item.result === "failure" ? "Paid, remembered" : "Paid";
  return LABEL[item.state] ?? item.state;
}

export const tone = (item) => story(item).tone;

// Who asked: a connected agent, or the person themselves in the app.
export const who = (item) => (item.source?.kind === "agent" ? item.source.name : "You");

// Animated dot-matrix word, one character at a time.
export function verdict(word, toneName) {
  return h("p.verdict", { class: `is-${toneName}`, "aria-hidden": "true" },
    [...word].map((ch, i) => h("span.ch", { style: `--c:${i}` }, ch === " " ? " " : ch)));
}

// Evidence rows: what moved on Sui, what Walrus Memory holds, and what the provider answered.
export function evidence(item, network) {
  const rows = [];
  const row = (term, ...value) => rows.push(h("div.ev-row", {}, h("dt", {}, term), h("dd", {}, ...value)));
  if (item.amountMist) row(item.state === "paid" || item.state === "settling" || item.state === "uncertain" ? "Amount" : item.state === "blocked" ? "Would have cost" : "Price", `${sui(item.amountMist)} SUI`);
  row("Requested by", item.source?.kind === "agent" ? `${item.source.name} (agent)` : "You, in the app");
  if (item.provider) row("Provider", h("span.mono", {}, item.provider));
  if (item.terms?.payTo) row("Pays", h("span.mono", {}, shortId(item.terms.payTo)));
  if (item.digest && ["paid", "uncertain", "settling"].includes(item.state)) {
    row("Sui transaction", link(txUrl(network, item.digest), shortId(item.digest)), item.verifiedAt ? h("span.ev-note", {}, `Verified through Tatum, ${dateTime(item.verifiedAt)}`) : null);
  }
  if (item.memory === "failed") row("Walrus Memory", h("span.ev-warn", {}, icon("alert"), "Not saved. Edith could not write this outcome."));
  else if (item.memory === "saving") row("Walrus Memory", h("span.ev-note", {}, "Saving…"));
  else if (item.blobId) row("Walrus Memory", link(blobUrl(network, item.blobId), shortId(item.blobId)));
  const basis = item.decision?.basis;
  if (item.state === "blocked" && basis) {
    if (basis.digest) row("Earlier payment", link(txUrl(network, basis.digest), shortId(basis.digest)));
    if (basis.blobId) row("Remembered in", link(blobUrl(network, basis.blobId), shortId(basis.blobId)));
  }
  if (item.status) row("Response", `HTTP ${item.status}`);
  return h("dl.evidence", {}, rows);
}

export function responsePreview(item) {
  if (item.body === null || item.body === undefined) return null;
  return h("details.preview", {}, h("summary", {}, "What the provider returned"), h("pre", {}, item.body === "{}" ? "{}  (empty)" : item.body));
}
