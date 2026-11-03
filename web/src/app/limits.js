// Limits: what Edith may spend for this wallet. Enforced on the server before every quote is shown
// and again before every signed payment is sent, whatever memory says. The page shows the two limits as
// editable amounts, what the last 24 hours actually spent against them, and exactly where they apply.
import { h, mount } from "./dom.js";
import { ago, dateTime, sui, toMist } from "./format.js";

const DAY_MS = 24 * 60 * 60_000;
const COUNTED = new Set(["paid", "settling", "uncertain"]); // mirrors spentToday in src/store.mjs
const PRESETS = { perCall: ["1000000", "5000000", "10000000"], daily: ["10000000", "20000000", "100000000"] };

// Kept across re-renders so a balance refresh never wipes what someone is typing.
const draft = { perCall: null, daily: null };

export function renderLimits(root, app) {
  const { config } = app.state;
  let saving = false;
  let status = { tone: "", text: "" };

  function render() {
    const me = app.state.me;
    if (!me) return mount(root, h("div.card", {}, h("div.skeleton")));
    const saved = { perCall: me.limits.perCallMist, daily: me.limits.dailyMist };
    const value = (key) => draft[key] ?? sui(saved[key]);
    const mist = { perCall: toMist(value("perCall")), daily: toMist(value("daily")) };
    const dirty = mist.perCall !== null && mist.daily !== null
      ? String(mist.perCall) !== saved.perCall || String(mist.daily) !== saved.daily
      : true;
    const problem = check(mist);

    const limitCard = (key, title, sub, max) => {
      const input = h(`input.limit-input#limit-${key}`, {
        inputmode: "decimal", autocomplete: "off", value: value(key), "aria-describedby": `limit-${key}-sub`,
        "aria-invalid": mist[key] === null ? "true" : null,
        oninput: (e) => { draft[key] = e.target.value; status = { tone: "", text: "" }; rerenderKeepingFocus(e.target); },
      });
      return h("section.card.limit-card", { "aria-labelledby": `limit-${key}-label` },
        h("div.limit-head", {},
          h("label.limit-label#limit-" + key + "-label", { for: `limit-${key}` }, title),
          h("span.limit-max.mono", {}, `max ${sui(max)} SUI`)),
        h("div.limit-amount", {}, input, h("span.limit-unit", {}, "SUI")),
        h("p.limit-sub", { id: `limit-${key}-sub` }, sub),
        h("div.presets", { role: "group", "aria-label": `${title} presets` }, PRESETS[key].map((p) =>
          h("button.preset", { type: "button", "aria-pressed": String(mist[key] !== null && String(mist[key]) === p), onclick: () => { draft[key] = sui(p); status = { tone: "", text: "" }; render(); } }, sui(p)))));
    };

    const spent = BigInt(me.spentMist);
    const daily = mist.daily ?? BigInt(saved.daily);
    const left = daily > spent ? daily - spent : 0n;
    const pct = daily > 0n ? Math.min(100, Number((spent * 1000n) / daily) / 10) : 100;
    const unconfirmed = !me.limitsSetAt;
    const save = h("button.btn", { type: "submit", disabled: saving || (!dirty && !unconfirmed) || Boolean(problem) }, saving ? "Saving…" : !dirty && unconfirmed ? "Confirm these limits" : "Save limits");
    const statusText = problem ?? status.text ?? "";
    const statusTone = problem ? "bad" : status.tone;

    const form = h("form.limits-form", { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(mist); } },
      h("div.limit-pair", {},
        limitCard("perCall", "Most per payment", "Any single price above this is held. Nothing is paid.", config.maxPriceMist),
        limitCard("daily", "Most in 24 hours", "Rolling window. Payments still settling count.", config.maxDailyMist)),
      h("section.card.usage", { "aria-label": "Spending in the last 24 hours" },
        h("div.usage-figures", {},
          figure("Spent, last 24 hours", `${sui(spent)}`),
          figure("Left today", `${sui(left)}`),
          figure("Payments counted", String(counted(me).length))),
        h("div.usage-meter", { role: "meter", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(pct)), "aria-label": "Share of 24-hour limit spent" },
          h("span", { style: `width:${pct}%` })),
        h("div.usage-foot", {},
          h("p.form-status", { role: "status", class: statusTone ? `is-${statusTone}` : "" }, statusText || (dirty ? "Unsaved changes" : unconfirmed ? "These are the starting limits. Confirm them or pick your own." : "Saved. Applies to every request from this wallet.")),
          h("div.usage-actions", {},
            dirty && !saving ? h("button.btn.btn--light", { type: "button", onclick: () => { draft.perCall = null; draft.daily = null; status = { tone: "", text: "" }; render(); } }, "Discard") : null,
            save))));

    mount(root,
      h("header.page-head", {},
        h("p.eyebrow", {}, "Limits"),
        h("h1.page-title", {}, "Spending permissions, ", h("span.soft", {}, "in your hands."))),
      form,
      h("div.limits-detail", {}, countedCard(me), enforcementCard(config)));
  }

  const figure = (label, amount) => h("div.figure", {}, h("p.figure-label", {}, label), h("p.figure-value", {}, amount, h("span.figure-unit", {}, label === "Payments counted" ? "" : " SUI")));

  function check({ perCall, daily }) {
    if (perCall === null || daily === null) return "Enter amounts in SUI, like 0.005.";
    if (perCall > BigInt(config.maxPriceMist)) return `The most per payment is ${sui(config.maxPriceMist)} SUI.`;
    if (daily > BigInt(config.maxDailyMist)) return `The most in 24 hours is ${sui(config.maxDailyMist)} SUI.`;
    if (daily < perCall) return "The 24-hour limit can't be lower than the limit per payment.";
    return null;
  }

  // Re-render on input without losing the caret.
  function rerenderKeepingFocus(target) {
    const id = target.id;
    const caret = target.selectionStart;
    render();
    const next = document.getElementById(id);
    next?.focus();
    next?.setSelectionRange(caret, caret);
  }

  async function submit(mist) {
    if (saving || check(mist)) return;
    saving = true;
    render();
    try {
      await app.api.setLimits({ perCallMist: String(mist.perCall), dailyMist: String(mist.daily) });
      draft.perCall = null;
      draft.daily = null;
      await app.refreshMe();
      status = { tone: "good", text: "Saved. New limits apply to the next request." };
    } catch (err) {
      status = { tone: "bad", text: err.message };
    }
    saving = false;
    render();
  }

  render();
  // Polling refreshes the numbers, but never while someone is typing a limit.
  return { update() { if (!root.contains(document.activeElement) || !document.activeElement.matches("input")) render(); }, leave() {} };
}

function counted(me) {
  const since = Date.now() - DAY_MS;
  return me.activity.filter((a) => COUNTED.has(a.state) && Date.parse(a.at) >= since);
}

function countedCard(me) {
  const items = counted(me);
  return h("section.card.detail-card", { "aria-labelledby": "counted-title" },
    h("div.card-head", {}, h("h2.card-title#counted-title", {}, "Counted toward today"), h("span.tag.tag--quiet", {}, "Last 24 hours")),
    items.length
      ? h("ul.counted", {}, items.map((a) => h("li.counted-row", {},
        h("span.counted-main", {}, h("span.counted-request.mono", {}, a.request ?? a.url), h("span.counted-time", { title: dateTime(a.at) }, ago(a.at))),
        h("span.counted-state", { class: a.state === "paid" ? "" : "is-wait" }, a.state === "paid" ? "Paid" : "Unconfirmed"),
        h("span.counted-amount.mono", {}, `${sui(a.amountMist)} SUI`))))
      : h("p.detail-empty", {}, "Nothing has been paid in the last 24 hours."),
    h("div.counted-total", {},
      h("span", {}, "Refused, held and declined requests never count."),
      h("span.mono", {}, `Total ${sui(me.spentMist)} SUI`)));
}

// Where the limits apply, stated as rules rather than reassurance.
function enforcementCard(config) {
  const rows = [
    ["Before a price is shown", "Quote against both limits", "Held, wallet never asked"],
    ["Before the transfer is sent", "Both limits again, in one write", "Not sent, nothing paid"],
    ["Every call, always", `${sui(config.maxPriceMist)} SUI hard ceiling`, "Refused, whatever you set"],
    ["Memory", "Can refuse a payment", "Can never raise a limit"],
  ];
  return h("section.card.detail-card", { "aria-labelledby": "rules-title" },
    h("div.card-head", {}, h("h2.card-title#rules-title", {}, "Where limits apply"), h("span.tag.tag--quiet", {}, "Server side")),
    h("table.spec", {},
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "When"), h("th", { scope: "col" }, "Checks"), h("th", { scope: "col" }, "If over"))),
      h("tbody", {}, rows.map(([when, what, result]) => h("tr", {}, h("th", { scope: "row" }, when), h("td", {}, what), h("td", {}, result))))));
}
