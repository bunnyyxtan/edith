// Activity: everything Edith decided for this wallet, newest first: who asked, what Edith did, and the proof.
import { h, icon, mount } from "./dom.js";
import { ago, dateTime, sui } from "./format.js";
import { label, tone, who } from "./story.js";
import { openDetail } from "./detail.js";

const FILTERS = [
  ["all", "All"],
  ["approval", "Needs approval"],
  ["paid", "Paid"],
  ["refused", "Refused"],
  ["attention", "Unconfirmed"],
];

const matches = (filter, item) => {
  if (filter === "approval") return item.state === "awaiting";
  if (filter === "paid") return item.state === "paid";
  if (filter === "refused") return item.state === "blocked";
  if (filter === "attention") return ["uncertain", "settling"].includes(item.state) || item.memory === "failed";
  return true;
};

let filter = "all";

// Only money that moved, or may have, is shown as spent. A quote awaiting approval shows its price, muted.
const MOVED = new Set(["paid", "settling", "uncertain"]);
function amountCell(item) {
  if (MOVED.has(item.state)) return h("span.row-amount.mono", {}, `${sui(item.amountMist)} SUI`);
  if (item.state === "awaiting") return h("span.row-amount.mono.soft", {}, `${sui(item.amountMist)} SUI asked`);
  return h("span.row-amount.mono.soft", {}, "0 SUI");
}

export function activityRow(app, item) {
  return h("li", {},
    h("button.row", { type: "button", onclick: () => openDetail(app, item.id) },
      h("span.row-dot", { class: `is-${tone(item)}`, "aria-hidden": "true" }),
      h("span.row-main", {},
        h("span.row-title.mono", {}, item.request ?? item.url),
        h("span.row-sub", {}, h("strong.row-who", {}, who(item)), " · ", item.provider, " · ", h("time", { datetime: item.at, title: dateTime(item.at) }, ago(item.at)))),
      amountCell(item),
      h("span.badge", { class: `is-${tone(item)}` }, label(item)),
      icon("arrow")));
}

export function renderActivity(root, app) {
  const list = h("div.card.list-card");
  const tabs = h("div.segmented", { role: "tablist", "aria-label": "Filter activity" });

  mount(root,
    h("header.page-head", {},
      h("p.eyebrow", {}, "Activity"),
      h("h1.page-title", {}, "Every decision, ", h("span.soft", {}, "who asked for it, and the proof."))),
    tabs,
    list);

  function renderTabs() {
    const waiting = (app.state.me?.activity ?? []).filter((a) => a.state === "awaiting").length;
    mount(tabs, FILTERS.map(([key, text]) => h("button.segment", {
      type: "button", role: "tab", "aria-selected": String(filter === key),
      onclick: () => { filter = key; renderTabs(); renderList(); },
    }, text, key === "approval" && waiting ? h("span.count", {}, String(waiting)) : null)));
  }

  function renderList() {
    const activity = app.state.me?.activity;
    if (!activity) return mount(list, h("div.skeleton-list", { "aria-label": "Loading activity" }, [1, 2, 3].map(() => h("div.skeleton"))));
    const items = activity.filter((a) => matches(filter, a));
    if (!items.length) {
      return mount(list, h("div.empty", {},
        h("div.empty-mark", { "aria-hidden": "true" }, h("i"), h("i"), h("i")),
        h("p.empty-title", {}, activity.length ? "Nothing here" : "No activity yet"),
        h("p.empty-text", {}, activity.length ? "Nothing in your activity matches this filter." : "When a connected agent asks Edith to pay for something, the decision and its proof show up here."),
        activity.length ? null : h("a.btn", { href: "/app/agents", onclick: app.go("/app/agents") }, "Connect an agent")));
    }
    mount(list, h("ul.rows", {}, items.map((item) => activityRow(app, item))));
  }

  renderTabs();
  renderList();
  return { update() { renderTabs(); renderList(); }, leave() {} };
}
