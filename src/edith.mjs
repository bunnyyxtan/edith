// Edith's core, split at the point where money could move:
//   plan(url)            recall memory, judge, read the price, apply the payer's limits. Nothing is paid.
//   settle(plan, signed) check the payer's signed transfer, hand it to the provider, confirm on Sui
//                        through Tatum what actually moved, judge the response, remember the outcome.
// Edith never holds the payer's key: the payer's wallet signs each transfer it approves.
// Both report progress through `emit`, so a CLI or a UI can show exactly what is happening.
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { NAMESPACE, describeRequest, loadHistory, rememberEvent } from "./memory.mjs";
import { parseTerms, paymentHeader, transactionDigest } from "./payment.mjs";
import { classifyResponse, decide } from "./policy.mjs";
import { checkTransfer, verifyPayment } from "./sui.mjs";

export const MAX_PRICE_MIST = 10_000_000n; // hard ceiling per call, above any limit a payer can set: 0.01 SUI
const REDEEM_ATTEMPTS = 4;

export const isUsefulQuote = (body) => typeof body?.priceUsd === "number";

// `paid` says whether SUI reached the provider. It is known for every stage except "uncertain".
export class SettleError extends Error {
  constructor(stage, message, { digest, paid = false, cause } = {}) {
    super(message, { cause });
    this.stage = stage;
    this.digest = digest ?? null;
    this.paid = paid;
  }
}

// The exact transfer a quote asks for. The payer's wallet picks gas and signs it.
export function transferTransaction({ payTo, amount }, sender) {
  const tx = new Transaction();
  if (sender) tx.setSender(sender);
  const [coin] = tx.splitCoins(tx.gas, [amount]);
  tx.transferObjects([coin], payTo);
  return tx;
}

// MIST as a SUI amount people can read: 1000000n -> "0.001 SUI".
const mist = (value) => `${value / 1_000_000_000n}${`.${String(value % 1_000_000_000n).padStart(9, "0")}`.replace(/\.?0+$/, "")} SUI`;

const UNANSWERED = { kind: "transient", reason: "paid, but the provider never answered" };

function outcomeRecord(context, terms, digest, problem) {
  const outcome = { event: "outcome", ...context, paid: terms.amount, digest };
  return problem ? { ...outcome, result: "failure", kind: problem.kind, reason: problem.reason } : { ...outcome, result: "success" };
}

// The payer's own limits, checked after memory has had its say.
function checkLimits(price, { limits, spentMist = 0n }) {
  if (!limits) return null;
  if (price > limits.perCallMist) return `price ${mist(price)} is over your ${mist(limits.perCallMist)} limit per payment`;
  if (spentMist + price > limits.dailyMist) return `paying ${mist(price)} would take you past your ${mist(limits.dailyMist)} limit for 24 hours (${mist(spentMist)} spent)`;
  return null;
}

export function createEdith({ sui, memory, network, payer, namespace = NAMESPACE, isUseful = isUsefulQuote, fetch = globalThis.fetch }) {
  const declined = async (context, decision) => {
    await rememberEvent(memory, { event: "avoided", ...context, saved: decision.saved ?? 0, reason: decision.reason }, { wait: false, namespace });
    return { action: "skip", context, decision };
  };

  async function plan(url, options = {}, emit = () => {}) {
    const request = describeRequest("GET", url);
    const context = { ...request, network };
    const history = await loadHistory(memory, context, namespace);
    emit({ step: "recalled", history });

    // Known-bad requests are declined before the provider is even contacted.
    const early = decide(history, { key: request.key, now: Date.now() });
    if (early.action === "skip") return declined(context, { ...early, source: "memory" });

    const first = await fetch(url);
    if (first.status !== 402) return { action: "free", context, status: first.status, body: await first.json().catch(() => null) };
    const terms = parseTerms(await first.json(), network, MAX_PRICE_MIST);
    emit({ step: "quoted", terms });

    const decision = decide(history, { key: request.key, price: terms.amount, now: Date.now() });
    if (decision.action === "skip") return declined(context, { ...decision, source: "memory" });
    const overLimit = checkLimits(terms.amount, options);
    if (overLimit) return { action: "skip", context, terms, decision: { action: "skip", reason: overLimit, source: "limit", basis: null } };
    return { action: "pay", url, context, history, decision: { ...decision, source: "memory" }, terms };
  }

  // A 503 means the provider could not settle yet, so the same signed payment is retried, never a new one.
  async function redeem(url, header, emit) {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, { headers: { "x-payment": header } });
      if (res.status !== 503 || attempt === REDEEM_ATTEMPTS) return res;
      const delayMs = Number(res.headers.get("retry-after") ?? 2) * 1000 * attempt;
      emit({ step: "retrying", delayMs, attempt });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  const remember = async (record, digest, emit) => {
    try {
      // Waited on: later decisions about this endpoint depend on this outcome.
      const { blob_id: blobId } = await rememberEvent(memory, record, { namespace });
      emit({ step: "remembered", blobId });
      return blobId;
    } catch (err) {
      throw new SettleError("remember", "The payment is settled, but Edith could not save the outcome to Walrus Memory.", { digest, paid: true, cause: err });
    }
  };

  // signed: { transaction: base64 BCS, signature: base64 }, produced by the payer's wallet.
  async function settle(planned, signed, emit = () => {}) {
    const { url, context, terms } = planned;
    const bytes = fromBase64(signed.transaction);
    const digest = transactionDigest(bytes);

    emit({ step: "checking", digest });
    const problem = await checkTransfer(sui, bytes, { sender: payer, payTo: terms.payTo, amount: terms.amount });
    if (problem) throw new SettleError("check", `Edith did not send this payment: ${problem}.`, { digest });

    emit({ step: "paying", amount: terms.amount, payTo: terms.payTo, digest });
    let response;
    try {
      response = await redeem(url, paymentHeader({ challenge: terms.challenge, ...signed }), emit);
    } catch (err) {
      response = null;
      emit({ step: "unreachable", message: err.message });
    }

    // Whatever the provider said, Sui decides whether money moved. Edith checks it independently through Tatum.
    const body = response ? await response.json().catch(() => null) : null;
    const verification = await verifyPayment(sui, digest, { payTo: terms.payTo, minAmount: terms.amount });
    if (!verification.ok && !response) {
      throw new SettleError("uncertain", "The provider didn't answer, and your payment hasn't appeared on Sui yet.", { digest });
    }
    if (!verification.ok) {
      const why = body?.error ? `: ${body.error}` : "";
      throw new SettleError("refused", `The provider refused the payment${why}. Nothing was paid.`, { digest });
    }
    emit({ step: "verified", digest, received: verification.received, timestampMs: verification.timestampMs });

    // Paid and no answer is an outcome too: the money is gone and nothing came back.
    const judged = response ? classifyResponse(response.status, body, isUseful) : UNANSWERED;
    emit({ step: "judged", status: response?.status ?? null, body, problem: judged });
    const blobId = await remember(outcomeRecord(context, terms, digest, judged), digest, emit);
    return { result: judged ? "failure" : "success", digest, status: response?.status ?? null, body, problem: judged, blobId, verification };
  }

  // A payment whose fate was unknown: look again, and if it landed after all, remember it went unanswered.
  async function reconcile({ context, terms, digest }, emit = () => {}) {
    const verification = await verifyPayment(sui, digest, { payTo: terms.payTo, minAmount: terms.amount });
    if (!verification.ok) return { paid: false, verification };
    const blobId = await remember(outcomeRecord(context, terms, digest, UNANSWERED), digest, emit);
    return { paid: true, verification, blobId, problem: UNANSWERED };
  }

  return { plan, settle, reconcile };
}
