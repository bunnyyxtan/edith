// One request in a dialog: the decision, its evidence, and whatever it still allows. A payment waiting for
// approval (usually an agent's) is reviewed and approved here: Edith fetches a fresh price if the old quote
// ran out, the wallet signs the exact transfer, and each settlement step appears as it happens.
import { h, icon, mount } from "./dom.js";
import { countdown, dateTime, shortId, sui } from "./format.js";
import { evidence, problemText, responsePreview, story, verdict, who } from "./story.js";

const PAY_STEPS = [
  ["checking", "Check the signed payment"],
  ["paying", "Send to the provider"],
  ["verified", "Confirm on Sui through Tatum"],
  ["judged", "Judge the answer"],
  ["remembered", "Save to Walrus Memory"],
];

export function openDetail(app, id) {
  const dialog = document.querySelector("[data-detail]");
  const body = dialog.querySelector("[data-detail-body]");
  let live = null; // the item as this dialog last saw it, ahead of the next /api/me refresh
  let phase = "view"; // view | refreshing | signing | paying | done
  let reached = {}; // pay step -> detail text
  let failedStep = null;
  let error = null;
  let timer = null;

  const item = () => live ?? app.state.me?.activity.find((a) => a.id === id);

  function render() {
    clearInterval(timer);
    const it = item();
    if (!it) return mount(body, h("p.card-text", {}, "Edith has no record of this request."));
    const s = story(it);
    const parts = [verdict(s.word, s.tone), h("h2.outcome-title#detail-title", {}, s.title), h("p.outcome-text", {}, s.text)];
    parts.push(h("p.detail-request.mono", {}, it.request ?? it.url));
    if (error) parts.push(h("div.notice.notice--bad", { role: "alert" }, icon("alert"), h("p", {}, error)));
    if (phase === "refreshing") parts.push(h("p.fine.detail-wait", {}, "Getting a fresh price from the provider…"));
    if (phase === "signing" || phase === "paying") parts.push(progress());
    else if (it.state === "awaiting" && !it.stale) parts.push(approval(it));
    parts.push(evidence(it, app.state.config.network), responsePreview(it));
    parts.push(h("p.fine", {}, `Recorded ${dateTime(it.at)}`));
    const actions = followUps(it);
    if (actions.length) parts.push(h("div.actions", {}, actions));
    mount(body, ...parts);
  }

  function approval(it) {
    const expires = Date.parse(it.expiresAt);
    const left = h("span.mono", {}, countdown(expires - Date.now()));
    const balance = app.state.balance;
    const short = balance !== null && balance !== undefined && BigInt(balance) < BigInt(it.amountMist);
    timer = setInterval(() => {
      const ms = expires - Date.now();
      left.textContent = countdown(ms);
      if (ms <= 0) {
        clearInterval(timer);
        if (it.source?.kind === "agent") refresh();
        else { live = { ...it, state: "expired" }; render(); }
      }
    }, 1000);
    return h("div.approval.approval--dialog", {},
      h("div.approval-amount", {}, h("p.eyebrow", {}, `${who(it)} asks to pay`), h("p.amount", {}, sui(it.amountMist), h("span", {}, " SUI"))),
      h("dl.evidence", {},
        h("div.ev-row", {}, h("dt", {}, "To"), h("dd", {}, h("span.mono", {}, it.provider), h("span.ev-note.mono", { title: it.terms.payTo }, shortId(it.terms.payTo)))),
        h("div.ev-row", {}, h("dt", {}, "Price good for"), h("dd", {}, left))),
      short ? h("div.notice.notice--bad", {}, icon("alert"), h("p", {}, `Your wallet holds ${sui(balance)} SUI, less than this payment.`)) : null,
      h("p.fine", {}, "Your wallet shows this exact transfer. Edith checks it before sending it. Payments on Sui are final."),
      h("div.actions", {},
        h("button.btn", { type: "button", disabled: short, onclick: () => approve(it) }, icon("wallet"), "Approve in wallet"),
        h("button.btn.btn--light", { type: "button", onclick: () => decline(it) }, "Decline")));
  }

  function progress() {
    return h("ol.timeline.timeline--compact", { "aria-live": "polite" },
      [["signing", phase === "signing" ? "Approve in your wallet" : "Signed by your wallet"], ...PAY_STEPS].map(([key, title], i) => {
        const status = key === "signing" ? (phase === "signing" ? "active" : "done")
          : key in reached ? (failedStep === key ? "bad" : "done")
          : phase === "paying" && Object.keys(reached).length === i - 1 ? "active" : "pending";
        return h("li.tl", { class: `is-${status}` },
          h("span.tl-node", { "aria-hidden": "true" }, status === "done" ? icon("check") : status === "bad" ? icon("cross") : null),
          h("div.tl-body", {}, h("p.tl-title", {}, title), reached[key] ? h("p.tl-detail", {}, reached[key]) : null));
      }));
  }

  function followUps(it) {
    const out = [];
    if (it.state === "uncertain") out.push(h("button.btn", { type: "button", onclick: recheck }, icon("refresh"), "Check Sui again"));
    return out;
  }

  // A stale agent request gets a fresh quote first; memory and limits are checked again on the way.
  async function refresh() {
    phase = "refreshing";
    error = null;
    render();
    try {
      live = (await app.api.requote(id)).activity;
    } catch (err) {
      error = err.message;
    }
    phase = "view";
    render();
  }

  async function approve(it) {
    phase = "signing";
    error = null;
    render();
    let signed;
    try {
      signed = await app.signFor(it);
    } catch (err) {
      phase = "view";
      error = err.declined ? "You declined in your wallet. Nothing was paid." : err.message;
      return render();
    }
    phase = "paying";
    reached = {};
    render();
    try {
      await app.api.pay(it.id, signed, (e) => {
        if (e.step === "paying") reached.checking = "Exact amount, exact payee, your account";
        if (e.step === "unreachable") { reached.paying = "The provider didn't answer"; failedStep = "paying"; }
        if (e.step === "verified") { reached.paying ??= "Settled by the provider"; reached.verified = `${sui(e.received)} SUI reached the provider`; }
        if (e.step === "judged") { reached.judged = e.problem ? `The provider ${problemText(e.problem)}` : "A useful answer"; if (e.problem) failedStep = "judged"; }
        if (e.step === "remembered") reached.remembered = "Stored in your Walrus Memory";
        if (e.activity) live = e.activity;
        if (e.step === "error" && !e.activity) error = e.message;
        render();
      });
    } catch (err) {
      error = err.message;
    }
    phase = "done";
    await app.refreshMe();
    live = null;
    render();
  }

  async function decline(it) {
    try {
      live = (await app.api.cancel(it.id)).activity;
    } catch (err) {
      error = err.message;
    }
    await app.refreshMe();
    render();
  }

  async function recheck() {
    try {
      live = (await app.api.recheck(id)).activity;
      if (live.state === "uncertain") app.toast("Not on Sui yet. Try again in a minute.");
    } catch (err) {
      app.toast(err.message);
    }
    await app.refreshMe();
    live = null;
    render();
  }

  dialog.addEventListener("close", () => clearInterval(timer), { once: true });
  render();
  if (!dialog.open) dialog.showModal();
  if (item()?.state === "awaiting" && item()?.stale) refresh();
  return { update: () => { if (phase === "view" && !live) render(); } };
}
