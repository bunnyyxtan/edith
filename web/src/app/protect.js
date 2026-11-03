// Protect: ask Edith about a paid request, approve the payment in your wallet, and watch every step
// happen, from memory recall to Sui settlement to Walrus Memory. The guide walks a first-time visitor
// through the demonstration with real payments: pay for a good answer, pay for a bad one, then ask again.
// Layout: full-width bands (request, guide), then the request's steps beside Edith's decision.
import { h, icon, mount } from "./dom.js";
import { countdown, shortId, sui } from "./format.js";
import { evidence, plainReason, problemText, responsePreview, story, verdict } from "./story.js";

// The current run outlives tab switches, so leaving and coming back keeps the page as it was.
let view = null; // the mounted screen; work started on an earlier mount reports here
const run = { url: "", busy: false, steps: [], item: null, error: null, phase: "idle" };

// Every request walks the same path; steps it never reaches stay visible, so runs are comparable.
const STEPS = [
  ["recall", "Recall memory", "Past outcomes for this endpoint, from your Walrus Memory"],
  ["quote", "Read the price", "Ask the provider what it charges"],
  ["decide", "Decide", "Weigh what memory says, then your limits"],
  ["sign", "Approve in your wallet", "Your wallet signs the exact transfer"],
  ["check", "Check the signed payment", "Simulated first: amount, payee, your account"],
  ["send", "Send to the provider", "The provider settles it on Sui"],
  ["verify", "Confirm on Sui through Tatum", "What actually arrived, not the provider's word"],
  ["judge", "Judge the answer", "Was it worth paying for?"],
  ["remember", "Save to Walrus Memory", "So the next decision knows"],
];

// What every request ends in, shown before the first one so the screen explains itself.
const VERDICTS = [
  ["PAID.", "good", "Worth paying", "Your wallet approves, the provider answers, Edith verifies it on Sui."],
  ["REFUSED.", "hold", "Failed before", "Memory recalls a paid failure. The provider isn't even asked."],
  ["HELD.", "muted", "Over your limits", "The price breaks a limit you set. Nothing is paid."],
];

function setStep(key, status, detail) {
  const existing = run.steps.find((s) => s.key === key);
  if (existing) Object.assign(existing, { status, detail: detail ?? existing.detail });
  else run.steps.push({ key, status, detail });
}

const finishActive = (status = "done") => run.steps.forEach((s) => { if (s.status === "active") s.status = status; });
const motion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth");

// Guide progress comes from the person's real activity, never from a script.
function guide(app) {
  const base = app.state.config.demo.baseUrl;
  const demo = (item, ticker) => item.url === `${base}?ticker=${ticker}`;
  const activity = app.state.me?.activity ?? [];
  const steps = [
    { ticker: "SUI", title: "Pay for a quote that works", text: "A real 0.001 SUI payment for a live SUI price. Edith remembers the provider delivered.", done: activity.some((a) => demo(a, "SUI") && a.state === "paid" && a.result === "success") },
    { ticker: "ZZZ", title: "Pay for one that returns nothing", text: "The provider takes 0.001 SUI and answers with an empty body. Edith saves that to Walrus Memory.", done: activity.some((a) => demo(a, "ZZZ") && a.state === "paid" && a.result === "failure") },
    { ticker: "ZZZ", title: "Ask for it again", text: "An agent without memory would pay again. Edith recalls the failure and refuses. Costs nothing.", done: activity.some((a) => demo(a, "ZZZ") && a.state === "blocked" && a.decision?.source === "memory") },
  ];
  return { steps, next: steps.findIndex((s) => !s.done), base };
}

export function renderProtect(root, app) {
  const { config } = app.state;
  let timer = null;

  const input = h("input.field.field--url#url", {
    type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false", required: true,
    placeholder: "https://api.example.com/v1/data", value: run.url, "aria-describedby": "url-help",
    oninput: (e) => { run.url = e.target.value; },
  });
  const askButton = h("button.btn", { type: "submit" }, "Ask Edith");
  const budget = h("div.budget");
  const consoleCard = h("section.card.console", { "aria-label": "New request" },
    h("form.ask", { novalidate: true, onsubmit: (e) => { e.preventDefault(); ask(input.value); } },
      h("label.field-label", { for: "url" }, "Paid API address"),
      h("div.ask-row", {}, input, askButton),
      h("p.hint#url-help", {}, "Edith checks its memory, your limits and the price. Nothing is paid until you approve in your wallet.")),
    budget);

  const guideBand = h("section.band", { "aria-labelledby": "guide-title" });
  const stepsCard = h("section.card.run-steps", { "aria-labelledby": "steps-title" });
  const decisionCard = h("section.card.run-decision", { "aria-labelledby": "decision-title", "aria-live": "polite", "aria-busy": "false" });

  mount(root,
    h("header.page-head", {},
      h("p.eyebrow", {}, "Guided demo"),
      h("h1.page-title", {}, "Watch memory change ", h("span.soft", {}, "a real payment decision."))),
    consoleCard,
    guideBand,
    h("div.run-grid", {}, stepsCard, decisionCard));

  function renderGuide() {
    const { steps, next, base } = guide(app);
    const locked = run.busy || run.phase === "awaiting";
    mount(guideBand,
      h("div.band-head", {},
        h("div", {},
          h("h2.band-title#guide-title", {}, "See memory change a decision"),
          h("p.band-text", {}, `Three requests to ${config.demo.name}, a paid demo API. Steps 1 and 2 are real payments on Sui ${config.network} from your wallet.`)),
        h("span.tag", {}, next === -1 ? "Complete" : `${next} of 3 done`)),
      h("ol.guide-grid", {}, steps.map((s, i) => {
        const state = s.done ? "done" : i === next ? "next" : "later";
        return h("li.guide-card", { class: `is-${state}` },
          h("div.guide-top", {},
            h("span.guide-dot", { "aria-hidden": "true" }, s.done ? icon("check") : String(i + 1)),
            h("span.guide-state", {}, { done: "Done", next: "Next", later: `After step ${i}` }[state])),
          h("h3.guide-title", {}, s.title),
          h("p.guide-text", {}, s.text),
          h("div.guide-foot", {}, state === "next"
            ? h("button.btn.btn--small", { type: "button", disabled: locked, onclick: () => ask(`${base}?ticker=${s.ticker}`) }, `Run step ${i + 1}`, icon("arrow"))
            : h("span.guide-request.mono", {}, `ticker=${s.ticker}`)));
      })));
  }

  function renderBudget() {
    const me = app.state.me;
    if (!me) return mount(budget);
    const spent = BigInt(me.spentMist);
    const daily = BigInt(me.limits.dailyMist);
    const pct = daily > 0n ? Math.min(100, Number((spent * 1000n) / daily) / 10) : 0;
    mount(budget,
      h("div.budget-item", {}, h("p.budget-label", {}, "Per payment"), h("p.budget-value.mono", {}, `${sui(me.limits.perCallMist)} SUI`)),
      h("div.budget-item.budget-item--meter", {},
        h("p.budget-label", {}, "Spent in 24 hours"),
        h("p.budget-value.mono", {}, `${sui(me.spentMist)} `, h("span.soft", {}, `of ${sui(me.limits.dailyMist)} SUI`)),
        h("div.meter", { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)), "aria-label": "Share of 24-hour limit spent" }, h("span", { style: `width:${pct}%` }))),
      h("a.btn.btn--small.btn--light", { href: "/app/limits", onclick: app.go("/app/limits") }, "Change limits"));
  }

  function renderSteps() {
    const finished = run.phase === "done";
    mount(stepsCard,
      h("div.card-head", {}, h("h2.card-title#steps-title", {}, "What Edith does"), h("span.tag.tag--quiet", {}, run.phase === "idle" ? "9 steps" : run.busy ? "Working" : finished ? "Finished" : "Waiting for you")),
      h("ol.timeline", {}, STEPS.map(([key, title, hint]) => {
        const s = run.steps.find((x) => x.key === key);
        const status = s?.status ?? (finished ? "unused" : "pending");
        return h("li.tl", { class: `is-${status}` },
          h("span.tl-node", { "aria-hidden": "true" }, status === "done" ? icon("check") : status === "bad" ? icon("cross") : null),
          h("div.tl-body", {},
            h("p.tl-title", {}, title, h("span.visually-hidden", {}, ` (${status})`)),
            h("p.tl-detail", {}, s?.detail ?? hint)));
      })));
  }

  function renderDecision() {
    clearInterval(timer);
    decisionCard.setAttribute("aria-busy", String(run.busy));
    askButton.disabled = run.busy;
    const item = run.item;
    const head = h("div.card-head", {}, h("h2.card-title#decision-title", {}, "Decision"),
      run.url && run.phase !== "idle" ? h("span.mono.soft.truncate.decision-url", { title: run.url }, run.url) : null);
    const body = [];
    if (run.error && !(item && run.phase === "done")) body.push(h("div.notice.notice--bad", { role: "alert" }, icon("alert"), h("p", {}, run.error)));
    if (run.phase === "idle") body.push(legend());
    else if (!item && run.busy) body.push(working("CHECKING", "Recalling memory and reading the price.", "Nothing is paid at this stage."));
    else if (item && item.state === "awaiting" && run.phase !== "paying") body.push(approval(item));
    else if (item && run.phase === "paying") body.push(working("SENDING", `${sui(item.amountMist)} SUI, signed by your wallet.`, "Follow each step on the left. Edith confirms it on Sui before calling it paid."));
    else if (item && run.phase === "done") body.push(outcome(item));
    mount(decisionCard, head, ...body);
  }

  function legend() {
    return h("div.legend", {},
      h("p.legend-lede", {}, "Each request ends in one of three decisions, shown here with its evidence before anything is paid."),
      h("ul.legend-list", {}, VERDICTS.map(([word, tone, title, text]) => h("li.legend-item", {},
        h("p.legend-word", { class: `is-${tone}` }, word),
        h("div", {}, h("p.legend-title", {}, title), h("p.legend-text", {}, text))))));
  }

  function working(word, title, text) {
    return h("div.working", {}, verdict(word, "wait"), h("h3.outcome-title", {}, title), h("p.outcome-text", {}, text));
  }

  function approval(item) {
    const expires = Date.parse(item.expiresAt);
    const left = h("span.mono", {}, countdown(expires - Date.now()));
    const balance = app.state.balance;
    const short = balance !== null && balance !== undefined && BigInt(balance) < BigInt(item.amountMist);
    const approve = h("button.btn", { type: "button", disabled: short || run.busy, onclick: () => pay(item) }, icon("wallet"), "Approve in wallet");
    timer = setInterval(() => {
      const ms = expires - Date.now();
      left.textContent = countdown(ms);
      if (ms <= 0) {
        clearInterval(timer);
        run.item = { ...item, state: "expired" };
        run.phase = "done";
        app.refreshMe();
        view.render();
      }
    }, 1000);
    return h("div.approval", {},
      h("div.approval-amount", {}, h("p.eyebrow", {}, "Payment to approve"), h("p.amount", {}, sui(item.amountMist), h("span", {}, " SUI"))),
      h("dl.evidence", {},
        h("div.ev-row", {}, h("dt", {}, "Provider"), h("dd", {}, h("span.mono", {}, item.provider))),
        h("div.ev-row", {}, h("dt", {}, "Pays address"), h("dd", {}, h("span.mono", { title: item.terms.payTo }, shortId(item.terms.payTo)))),
        h("div.ev-row", {}, h("dt", {}, "Why Edith would pay"), h("dd", {}, item.decision?.reason ?? "Nothing in memory argues against it.")),
        h("div.ev-row", {}, h("dt", {}, "Quote expires in"), h("dd", {}, left))),
      short ? h("div.notice.notice--bad", {}, icon("alert"), h("p", {}, `Your wallet holds ${sui(balance)} SUI, less than this payment. Add SUI to your wallet, then try again.`)) : null,
      h("p.fine", {}, "Your wallet will show this exact transfer. Edith checks it before sending it to the provider. Payments on Sui are final."),
      h("div.actions", {}, approve, h("button.btn.btn--light", { type: "button", disabled: run.busy, onclick: () => decline(item) }, "Decline")));
  }

  function outcome(item) {
    const s = story(item);
    const parts = [verdict(s.word, s.tone), h("h3.outcome-title", {}, s.title), h("p.outcome-text", {}, s.text)];
    if (item.state === "blocked" && item.decision?.source === "memory") parts.push(compare(item));
    parts.push(evidence(item, config.network), responsePreview(item));
    const actions = [];
    if (item.state === "uncertain") actions.push(h("button.btn", { type: "button", onclick: () => recheck(item) }, icon("refresh"), "Check Sui again"));
    if (item.state === "paid" && item.result === "failure" && item.problem?.kind !== "transient") {
      actions.push(h("button.btn", { type: "button", onclick: () => ask(item.url) }, "Ask for it again"));
    }
    if (item.state === "expired" || item.state === "cancelled") actions.push(h("button.btn", { type: "button", onclick: () => ask(item.url) }, "Ask again"));
    if (item.state === "blocked" && item.decision?.source === "limit") actions.push(h("a.btn.btn--light", { href: "/app/limits", onclick: app.go("/app/limits") }, "Review limits"));
    actions.push(h("a.text-link", { href: "/app/activity", onclick: app.go("/app/activity") }, "See all activity"));
    parts.push(h("div.actions", {}, actions));
    return h("div.outcome", { class: `is-${s.tone}` }, parts);
  }

  // The same request, as an agent without memory would have handled it, next to what Edith did.
  function compare(item) {
    const basis = item.decision.basis;
    const cost = item.amountMist ? `${sui(item.amountMist)} SUI` : "the price";
    const got = basis?.reason ? plainReason(basis.reason) : "the same failure";
    return h("div.compare", {},
      h("div.compare-col", {},
        h("p.eyebrow", {}, "An agent without memory"),
        h("p.compare-line", {}, `Pays ${cost}`),
        h("p.compare-text", {}, `again, and gets ${got} again. Every session starts blank.`)),
      h("div.compare-col.is-edith", {},
        h("p.eyebrow", {}, "With Edith"),
        h("p.compare-line", {}, "Pays 0 SUI"),
        h("p.compare-text", {}, "Recalled the paid failure from Walrus Memory and refused before contacting the provider.")));
  }

  function render() {
    renderSteps();
    renderDecision();
  }

  async function ask(url) {
    if (run.busy) return;
    run.url = url.trim();
    input.value = run.url;
    if (!run.url) {
      input.focus();
      input.setAttribute("aria-invalid", "true");
      return;
    }
    input.removeAttribute("aria-invalid");
    Object.assign(run, { busy: true, steps: [], item: null, error: null, phase: "asking" });
    setStep("recall", "active");
    view.render();
    view.renderGuide();
    view.reveal();
    try {
      const last = await app.api.ask(run.url, (e) => {
        if (e.step === "recalled") {
          setStep("recall", "done", e.history.length ? `${e.history.length} past ${e.history.length === 1 ? "outcome" : "outcomes"} for this endpoint` : "Nothing remembered about this endpoint yet");
          setStep("quote", "active");
        }
        if (e.step === "quoted") setStep("quote", "done", `${sui(e.terms.amount)} SUI to ${shortId(e.terms.payTo)}`);
        if (e.step === "planned") {
          run.item = e.activity;
          const quoteStep = run.steps.find((s) => s.key === "quote");
          if (quoteStep?.status === "active") quoteStep.status = e.activity.state === "free" ? "done" : "skip";
          if (quoteStep?.status === "skip") quoteStep.detail = "Not asked: memory already decided";
          const pay = e.activity.state === "awaiting";
          setStep("decide", pay || e.activity.state === "free" ? "done" : "bad", pay ? "Edith would pay. Your approval is next." : story(e.activity).title);
          if (pay) setStep("sign", "active");
        }
        if (e.step === "error") {
          finishActive("bad");
          run.error = e.message;
        }
        view.render();
      });
      run.phase = run.item?.state === "awaiting" ? "awaiting" : "done";
      if (!last || (last.step !== "planned" && last.step !== "error")) run.error ??= "Edith stopped answering partway. Check Activity before trying again.";
    } catch (err) {
      finishActive("bad");
      run.error = err.message;
      run.phase = "done";
    }
    run.busy = false;
    await app.refreshMe();
    view.render();
    view.renderGuide();
    view.renderBudget();
  }

  async function pay(item) {
    if (run.busy) return;
    run.busy = true;
    run.error = null;
    view.render();
    let signed;
    try {
      signed = await app.signFor(item);
    } catch (err) {
      run.busy = false;
      run.error = err.declined ? "You declined in your wallet. Nothing was paid. You can approve again while the quote lasts." : err.message;
      view.render();
      return;
    }
    setStep("sign", "done", "Signed by your wallet");
    setStep("check", "active");
    run.phase = "paying";
    view.render();
    try {
      await app.api.pay(item.id, signed, (e) => {
        if (e.step === "paying") { setStep("check", "done", "Exact amount, exact payee, your account"); setStep("send", "active"); }
        if (e.step === "retrying") setStep("send", "active", `Provider busy, retrying (attempt ${e.attempt + 1})`);
        if (e.step === "unreachable") setStep("send", "bad", "The provider didn't answer");
        if (e.step === "verified") {
          if (run.steps.find((s) => s.key === "send")?.status === "active") setStep("send", "done", "Settled by the provider");
          setStep("verify", "done", `${sui(e.received)} SUI reached the provider`);
          setStep("judge", "active");
        }
        if (e.step === "judged") {
          setStep("judge", e.problem ? "bad" : "done", e.problem ? `The provider ${problemText(e.problem)}` : "A useful answer");
          setStep("remember", "active");
        }
        if (e.step === "remembered") setStep("remember", "done", "Stored in your Walrus Memory");
        if (e.step === "settled") run.item = e.activity;
        if (e.step === "error") {
          finishActive("bad");
          if (e.activity) run.item = e.activity;
          else run.error = e.message;
        }
        view.render();
      });
    } catch (err) {
      finishActive("bad");
      run.error = err.message;
    }
    run.busy = false;
    run.phase = "done";
    await app.refreshMe();
    if (!run.item || run.item.state === "awaiting") run.item = app.state.me?.activity.find((a) => a.id === item.id) ?? run.item;
    view.render();
    view.renderGuide();
    view.renderBudget();
  }

  async function decline(item) {
    run.busy = true;
    view.render();
    try {
      run.item = (await app.api.cancel(item.id)).activity;
      setStep("sign", "bad", "You declined");
      run.phase = "done";
    } catch (err) {
      run.error = err.message;
    }
    run.busy = false;
    await app.refreshMe();
    view.render();
    view.renderGuide();
  }

  async function recheck(item) {
    try {
      run.item = (await app.api.recheck(item.id)).activity;
      if (run.item.state === "uncertain") app.toast("Not on Sui yet. Edith will keep this marked until it can confirm.");
    } catch (err) {
      app.toast(err.message);
    }
    await app.refreshMe();
    view.render();
  }

  // Brings the request's steps and decision into view when a run starts.
  const reveal = () => decisionCard.parentElement.scrollIntoView({ behavior: motion(), block: "start" });
  view = { render, renderGuide, renderBudget, reveal };
  render();
  renderGuide();
  renderBudget();
  return {
    update() { view.renderGuide(); view.renderBudget(); },
    leave() { clearInterval(timer); },
  };
}
