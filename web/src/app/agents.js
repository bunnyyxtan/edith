// Agents: the software allowed to ask Edith about paid requests for this wallet. Connecting one creates a
// key shown once. A key can ask but never pay: payments wait for the owner's approval in the app.
import { h, icon, mount } from "./dom.js";
import { ago, dateTime, sui } from "./format.js";

let fresh = null; // { agent, token } just created; the token is shown once and never fetched again

export function renderAgents(root, app) {
  const origin = location.origin;
  let creating = false;
  let error = null;
  let confirming = null; // agent id whose disconnect is being confirmed

  function render() {
    const me = app.state.me;
    if (!me) return mount(root, h("div.card", {}, h("div.skeleton")));
    const agents = me.agents ?? [];
    const live = agents.filter((a) => !a.revokedAt);
    mount(root,
      h("header.page-head", {},
        h("p.eyebrow", {}, "Agents"),
        h("h1.page-title", {}, "Your agents ask. ", h("span.soft", {}, "Edith decides. You approve."))),
      fresh ? keyCard() : connectCard(live.length === 0),
      agents.length ? listCard(me, agents) : null,
      h("div.limits-detail", {}, howCard(), apiCard()));
  }

  function connectCard(first) {
    const input = h("input.field#agent-name", { autocomplete: "off", maxlength: "40", placeholder: "Research agent", "aria-describedby": "agent-name-help" });
    return h("section.card.connect-agent", { "aria-labelledby": "connect-agent-title" },
      h("div.connect-agent-copy", {},
        h("h2.band-title#connect-agent-title", {}, first ? "Connect your first agent" : "Connect another agent"),
        h("p.band-text", {}, "Edith gives the agent its own key. The agent sends Edith the paid URLs it wants; Edith refuses what memory or your limits rule out, and asks you to approve the rest.")),
      h("form.agent-form", { novalidate: true, onsubmit: (e) => { e.preventDefault(); create(input.value); } },
        h("label.field-label", { for: "agent-name" }, "Agent name"),
        h("div.agent-form-row", {}, input, h("button.btn", { type: "submit", disabled: creating }, creating ? "Creating…" : "Create agent key")),
        h("p.hint#agent-name-help", {}, "A name you'll recognise in approvals and activity."),
        error ? h("p.form-status.is-bad", { role: "alert" }, error) : null));
  }

  function keyCard() {
    const { agent, token } = fresh;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(token);
        app.toast("Agent key copied.");
      } catch {
        app.toast("Couldn't copy. Select the key and copy it.");
      }
    };
    return h("section.card.key-card", { "aria-labelledby": "key-title" },
      h("div.card-head", {}, h("h2.band-title#key-title", {}, `${agent.name} is connected`), h("span.tag", {}, "Shown once")),
      h("p.band-text", {}, "Give this key to your agent. Edith keeps only a fingerprint of it, so it can't be shown again. If it's lost, disconnect the agent and create a new key."),
      h("div.key-box", {}, h("code.key-value", {}, token), h("button.btn.btn--small.btn--light", { type: "button", onclick: copy }, icon("copy"), "Copy")),
      snippet(origin, token),
      h("div.actions", {}, h("button.btn", { type: "button", onclick: () => { fresh = null; render(); } }, "I've saved the key")));
  }

  function listCard(me, agents) {
    const stats = (id) => {
      const mine = me.activity.filter((a) => a.source?.agentId === id);
      const paid = mine.filter((a) => a.state === "paid").reduce((sum, a) => sum + BigInt(a.amountMist ?? 0), 0n);
      return { asked: mine.length, refused: mine.filter((a) => a.state === "blocked").length, waiting: mine.filter((a) => a.state === "awaiting").length, paid };
    };
    return h("section.card.list-card.agents-list", { "aria-label": "Connected agents" },
      h("ul.rows", {}, agents.map((a) => {
        const s = stats(a.id);
        const revoked = Boolean(a.revokedAt);
        return h("li.agent-row", { class: revoked ? "is-revoked" : "" },
          h("div.agent-main", {},
            h("p.agent-name", {}, a.name, h("span.badge", { class: revoked ? "" : "is-good" }, revoked ? "Disconnected" : "Active")),
            h("p.row-sub", {}, revoked ? `Disconnected ${ago(a.revokedAt)}` : a.lastUsedAt ? `Last asked ${ago(a.lastUsedAt)}` : `Connected ${ago(a.createdAt)}, hasn't asked yet`)),
          h("dl.agent-stats", {},
            stat("Asked", s.asked), stat("Refused", s.refused), stat("Waiting", s.waiting), stat("Paid", `${sui(s.paid)} SUI`)),
          revoked ? h("span") : confirming === a.id
            ? h("div.agent-confirm", {},
              h("button.btn.btn--small.btn--danger", { type: "button", onclick: () => revoke(a.id) }, "Disconnect"),
              h("button.btn.btn--small.btn--light", { type: "button", onclick: () => { confirming = null; render(); } }, "Keep"))
            : h("button.btn.btn--small.btn--light", { type: "button", onclick: () => { confirming = a.id; render(); }, title: `Created ${dateTime(a.createdAt)}` }, "Disconnect"));
      })));
  }

  const stat = (term, value) => h("div", {}, h("dt", {}, term), h("dd.mono", {}, String(value)));

  function howCard() {
    const rows = [
      ["Ask about a paid URL", "Yes", "Edith recalls, judges and quotes"],
      ["Get refused", "Instantly", "Memory or limits say no; nothing is paid"],
      ["Pay", "Never", "You approve each payment in your wallet"],
      ["Wait for approval", "Up to 24 hours", "A fresh price is fetched when you review"],
      ["Read the answer", "Its own requests", "Never another agent's or another wallet's"],
    ];
    return h("section.card.detail-card", { "aria-labelledby": "can-title" },
      h("div.card-head", {}, h("h2.card-title#can-title", {}, "What an agent key can do"), h("span.tag.tag--quiet", {}, "Enforced server side")),
      h("table.spec", {},
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Action"), h("th", { scope: "col" }, "Allowed"), h("th", { scope: "col" }, "How"))),
        h("tbody", {}, rows.map(([a, b, c]) => h("tr", {}, h("th", { scope: "row" }, a), h("td", {}, b), h("td", {}, c))))));
  }

  function apiCard() {
    return h("section.card.detail-card", { "aria-labelledby": "api-title" },
      h("div.card-head", {}, h("h2.card-title#api-title", {}, "Agent API"), h("span.tag.tag--quiet", {}, "Two calls")),
      h("dl.api-list", {},
        h("div", {}, h("dt.mono", {}, "POST /v1/requests"), h("dd", {}, "Send { \"url\": \"…\" }. The answer says blocked (and why), free, or awaiting your approval.")),
        h("div", {}, h("dt.mono", {}, "GET /v1/requests/:id"), h("dd", {}, "Poll until paid, refused or cancelled. A paid request carries the provider's answer and the Sui transaction.")),
        h("div", {}, h("dt.mono", {}, "POST /v1/requests/:id/cancel"), h("dd", {}, "Withdraw a request that no longer matters."))),
      h("p.fine", {}, "Send the key as Authorization: Bearer <key>."));
  }

  async function create(name) {
    if (creating) return;
    creating = true;
    error = null;
    render();
    try {
      fresh = await app.api.createAgent(name);
      await app.refreshMe();
    } catch (err) {
      error = err.message;
    }
    creating = false;
    render();
  }

  async function revoke(id) {
    try {
      await app.api.revokeAgent(id);
      app.toast("Agent disconnected. Its key no longer works.");
    } catch (err) {
      app.toast(err.message);
    }
    confirming = null;
    await app.refreshMe();
    render();
  }

  render();
  // Polling refreshes the list, but never while someone is typing an agent name.
  return { update() { if (!(root.contains(document.activeElement) && document.activeElement.matches("input"))) render(); }, leave() { fresh = null; } };
}

// A runnable example for the key just created.
function snippet(origin, token) {
  const code = `const EDITH = "${origin}";
const KEY = "${token}";

const ask = (url) => fetch(\`\${EDITH}/v1/requests\`, {
  method: "POST",
  headers: { authorization: \`Bearer \${KEY}\`, "content-type": "application/json" },
  body: JSON.stringify({ url }),
}).then((r) => r.json());

let request = await ask("https://api.example.com/v1/data");
while (request.state === "awaiting") {        // waiting for your approval in Edith
  await new Promise((r) => setTimeout(r, 5000));
  request = await fetch(\`\${EDITH}/v1/requests/\${request.id}\`, {
    headers: { authorization: \`Bearer \${KEY}\` },
  }).then((r) => r.json());
}
// request.state: paid (request.body), blocked (request.decision.reason), cancelled, expired`;
  return h("details.snippet", {}, h("summary", {}, "Example: call Edith from your agent (JavaScript)"), h("pre", {}, h("code", {}, code)));
}
