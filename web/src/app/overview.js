// Overview: where a person lands. Until Edith is set up it shows the three steps (wallet, agent, limits);
// after that, what needs them now (payments waiting for approval), what Edith decided lately, and what it
// has learned, each lesson linked to the outcome stored in Walrus Memory.
import { h, icon, link, mount } from "./dom.js";
import { ago, blobUrl, shortAddress, shortId, sui } from "./format.js";
import { activityRow } from "./activity.js";
import { openDetail } from "./detail.js";
import { plainReason, who } from "./story.js";

export function renderOverview(root, app) {
  function render() {
    const me = app.state.me;
    if (!me) return mount(root, h("div.card", {}, h("div.skeleton")));
    const live = (me.agents ?? []).filter((a) => !a.revokedAt);
    const steps = [
      { title: "Connect your wallet", text: `Signed in as ${shortAddress(me.address)}. Your wallet signs every payment; Edith never holds a key.`, done: true },
      { title: "Connect an agent", text: "Give your agent its own Edith key. It can ask about paid requests, never pay on its own.", done: live.length > 0, href: "/app/agents", action: "Connect an agent" },
      { title: "Set your protection", text: "Choose the most Edith may spend per payment and per day. Memory can only refuse within them.", done: Boolean(me.limitsSetAt), href: "/app/limits", action: "Review limits" },
    ];
    const ready = steps.every((s) => s.done);
    const waiting = me.activity.filter((a) => a.state === "awaiting");

    mount(root,
      h("header.page-head", {},
        h("p.eyebrow", {}, "Overview"),
        h("h1.page-title", {}, ready ? "Edith is on watch. " : "Set up Edith ", h("span.soft", {}, ready ? "Here's what needs you, and what it learned." : "in three steps, then let your agents ask."))),
      ready ? statusCard(me, live) : setupBand(steps),
      waiting.length ? approvals(waiting) : null,
      h("div.limits-detail", {}, recentCard(me), learnedCard(me)),
      me.activity.length ? null : demoCard());
  }

  function setupBand(steps) {
    const next = steps.findIndex((s) => !s.done);
    return h("section.band", { "aria-label": "Setup" },
      h("ol.guide-grid", {}, steps.map((s, i) => {
        const state = s.done ? "done" : i === next ? "next" : "later";
        return h("li.guide-card", { class: `is-${state}` },
          h("div.guide-top", {},
            h("span.guide-dot", { "aria-hidden": "true" }, s.done ? icon("check") : String(i + 1)),
            h("span.guide-state", {}, { done: "Done", next: "Next", later: "Then" }[state])),
          h("h3.guide-title", {}, s.title),
          h("p.guide-text", {}, s.text),
          h("div.guide-foot", {}, state === "done" || !s.href ? null
            : h("a.btn.btn--small", { class: state === "next" ? "" : "btn--light", href: s.href, onclick: app.go(s.href) }, s.action, icon("arrow"))));
      })));
  }

  function statusCard(me, live) {
    return h("section.card.status-card", { "aria-label": "Protection status" },
      h("div.status-main", {},
        h("span.status-dot", { "aria-hidden": "true" }),
        h("div", {},
          h("p.status-title", {}, `Protecting ${live.length} ${live.length === 1 ? "agent" : "agents"}`),
          h("p.row-sub", {}, live.map((a) => a.name).join(", ")))),
      h("dl.agent-stats.status-stats", {},
        h("div", {}, h("dt", {}, "Per payment"), h("dd.mono", {}, `${sui(me.limits.perCallMist)} SUI`)),
        h("div", {}, h("dt", {}, "Spent, 24 hours"), h("dd.mono", {}, `${sui(me.spentMist)} of ${sui(me.limits.dailyMist)} SUI`))),
      h("div.status-links", {},
        h("a.btn.btn--small.btn--light", { href: "/app/agents", onclick: app.go("/app/agents") }, "Agents"),
        h("a.btn.btn--small.btn--light", { href: "/app/limits", onclick: app.go("/app/limits") }, "Limits")));
  }

  function approvals(waiting) {
    return h("section.card.approvals", { "aria-labelledby": "approvals-title" },
      h("div.card-head", {}, h("h2.card-title#approvals-title", {}, "Waiting for your approval"), h("span.tag", {}, String(waiting.length))),
      h("ul.approval-list", {}, waiting.map((a) => h("li.approval-row", {},
        h("div.approval-who", {}, h("p.agent-name", {}, who(a)), h("p.row-sub.mono", {}, a.request ?? a.url)),
        h("p.approval-ask.mono", {}, `${sui(a.amountMist)} SUI`),
        h("p.row-sub", {}, `${a.provider} · ${ago(a.at)}`),
        h("button.btn.btn--small", { type: "button", onclick: () => openDetail(app, a.id) }, "Review")))));
  }

  function recentCard(me) {
    const recent = me.activity.slice(0, 5);
    return h("section.card.detail-card.recent-card", { "aria-labelledby": "recent-title" },
      h("div.card-head", {}, h("h2.card-title#recent-title", {}, "Recent decisions"),
        me.activity.length ? h("a.text-link", { href: "/app/activity", onclick: app.go("/app/activity") }, "All activity") : null),
      recent.length ? h("ul.rows.rows--tight", {}, recent.map((a) => activityRow(app, a)))
        : h("p.detail-empty", {}, "Nothing yet. Each request your agents send shows up here with Edith's decision."));
  }

  // One lesson per request: the latest outcome Edith saved to Walrus Memory, and how often it has acted on it.
  function learnedCard(me) {
    const lessons = new Map();
    for (const a of me.activity) {
      const key = a.request ?? a.url;
      if (a.state === "blocked" && a.decision?.source === "memory") {
        const l = lessons.get(key) ?? { key, refusals: 0 };
        l.refusals += 1;
        lessons.set(key, l);
      }
      if (a.state === "paid" && a.blobId) {
        const l = lessons.get(key) ?? { key, refusals: 0 };
        l.outcome ??= a; // activity is newest first, so the first one seen is the latest
        lessons.set(key, l);
      }
    }
    const rows = [...lessons.values()].filter((l) => l.outcome).slice(0, 6);
    return h("section.card.detail-card.learned-card", { "aria-labelledby": "learned-title" },
      h("div.card-head", {}, h("h2.card-title#learned-title", {}, "What Edith has learned"), h("span.tag.tag--quiet", {}, "Walrus Memory")),
      rows.length ? h("ul.lessons", {}, rows.map(({ key, outcome, refusals }) => {
        const bad = outcome.result === "failure";
        const cooling = outcome.problem?.kind === "transient";
        return h("li.lesson", {},
          h("div.lesson-main", {},
            h("p.lesson-request.mono", {}, key),
            h("p.lesson-text", {}, bad
              ? `${cooling ? "Waits 15 minutes before paying again" : "Refuses to pay again"}: it returned ${plainReason(outcome.problem?.reason)}.`
              : "Pays when asked: it delivered a useful answer."),
            h("p.row-sub", {}, refusals ? `Refused ${refusals} ${refusals === 1 ? "time" : "times"} since` : `Learned ${ago(outcome.verifiedAt ?? outcome.at)}`, " · ", link(blobUrl(app.state.config.network, outcome.blobId), shortId(outcome.blobId)))),
          h("span.badge", { class: bad ? "is-hold" : "is-good" }, bad ? (cooling ? "Cooling down" : "Refuses") : "Trusted"));
      })) : h("p.detail-empty", {}, "Nothing learned yet. After every paid request, Edith saves whether it was worth it, and uses that before the next payment."));
  }

  function demoCard() {
    return h("section.card.demo-card", { "aria-labelledby": "demo-title" },
      h("div", {},
        h("h2.card-title#demo-title", {}, "See it before connecting an agent"),
        h("p.card-text", {}, "The guided demo makes two small real payments to Quote Desk, then shows Edith refusing the one that wasn't worth it.")),
      h("a.btn.btn--light", { href: "/app/demo", onclick: app.go("/app/demo") }, "Open the guided demo", icon("arrow")));
  }

  render();
  return { update: render, leave() {} };
}
