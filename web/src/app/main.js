// Edith app shell: session, wallet, navigation and the screens. Signed out, there is one screen and one
// action: connect a wallet. Signed in: Overview, Activity, Agents, Limits, and the guided Demo.
import "./app.css";
import { api, ApiError } from "./api.js";
import { $, h, icon, link, mount } from "./dom.js";
import { accountUrl, shortAddress, sui, suiShort } from "./format.js";
import { createWallets, WalletError } from "./wallet.js";
import { renderOverview } from "./overview.js";
import { renderActivity } from "./activity.js";
import { renderAgents } from "./agents.js";
import { renderLimits } from "./limits.js";
import { renderProtect } from "./protect.js";
import { openDetail } from "./detail.js";

const ROUTES = {
  "/app": { title: "Overview", render: renderOverview },
  "/app/activity": { title: "Activity", render: renderActivity },
  "/app/agents": { title: "Agents", render: renderAgents },
  "/app/limits": { title: "Limits", render: renderLimits },
  "/app/demo": { title: "Demo", render: renderProtect },
};
const POLL_MS = 5000; // agents ask while the owner is away; the app checks for new requests this often

const view = $("[data-view]");
const nav = $("[data-nav]");
const account = $("[data-account]");
const toastEl = $("[data-toast]");
const modal = $("[data-wallet-modal]");
const modalBody = $("[data-wallet-body]");

const state = { config: null, address: null, me: null, balance: null };
let wallets = null;
let screen = null;

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-shown");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove("is-shown"), 5000);
}

// Link handler for in-app navigation.
const go = (path) => (e) => {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return;
  e?.preventDefault();
  navigate(path);
};

function navigate(path, { replace = false } = {}) {
  const target = ROUTES[path] ? path : "/app";
  if (location.pathname !== target) history[replace ? "replaceState" : "pushState"]({}, "", target);
  render();
}

// balance: false for background polls, so the Sui gateway is asked only when something may have changed.
async function refreshMe({ balance = true, quiet = false } = {}) {
  try {
    const me = await api.me();
    // A poll that finds nothing new leaves the screen alone: no re-render, no replayed entrance.
    if (!balance && JSON.stringify(me) === JSON.stringify(state.me)) return;
    state.me = me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return signedOut();
    if (!quiet) toast(err.message);
    return;
  }
  if (balance) {
    try {
      state.balance = (await api.balance()).mist;
    } catch {
      state.balance = null; // unknown balance never blocks a payment; the wallet will say if it is short
    }
  }
  renderNav();
  renderAccount();
  screen?.update();
}

let poll = null;
function startPolling() {
  clearInterval(poll);
  poll = setInterval(() => {
    if (state.address && document.visibilityState === "visible" && !document.querySelector("dialog[open]")) refreshMe({ balance: false, quiet: true });
  }, POLL_MS);
}

// The wallet that signed in must be the one that signs payments.
async function signFor(item) {
  if (wallets.current?.address !== state.address) await wallets.reconnect();
  if (wallets.current?.address !== state.address) await openWalletModal({ reconnect: true });
  if (wallets.current?.address !== state.address) {
    throw new WalletError(wallets.current
      ? `Your wallet is on ${shortAddress(wallets.current.address)}, but you signed in as ${shortAddress(state.address)}. Switch accounts in your wallet, or sign out and connect again.`
      : "Reconnect your wallet to approve this payment.");
  }
  return wallets.signTransfer(item.terms);
}

const app = { state, api, go, navigate, refreshMe, signFor, toast, get wallets() { return wallets; } };

/* Wallet modal */

let modalDone = null;

function openWalletModal({ reconnect = false } = {}) {
  return new Promise((resolve) => {
    modalDone = resolve;
    renderWalletChoice(reconnect);
    if (!modal.open) modal.showModal();
  });
}

modal.addEventListener("close", () => {
  modalDone?.();
  modalDone = null;
});

function modalStage({ wallet, title, text, busy = false, error = null, actions = [] }) {
  mount(modalBody,
    h("div.wm-stage", {},
      wallet ? h("div.wm-badge", {}, h("img.wm-icon.wm-icon--large", { src: wallet.icon, alt: "" }), busy ? h("span.wm-ring", { "aria-hidden": "true" }) : null) : null,
      h("h2.wm-title#wallet-title", {}, title),
      text ? h("p.wm-text", {}, text) : null,
      error ? h("p.wm-error", { role: "alert" }, error) : null,
      actions.length ? h("div.actions.actions--center", {}, actions) : null));
}

function renderWalletChoice(reconnect) {
  const list = wallets.list();
  const intro = reconnect
    ? `Reconnect the wallet you signed in with (${shortAddress(state.address)}) to approve this payment.`
    : "Choose the Sui wallet you want Edith to work with. Edith never sees your keys.";
  if (!list.length) {
    return mount(modalBody,
      h("h2.wm-title#wallet-title", {}, "No Sui wallet found"),
      h("p.wm-text", {}, "Edith works with any Sui wallet that runs in your browser, like Slush. Install one, create or import an account, then come back to this page."),
      h("p.wm-text", {}, "On a phone, open this page inside your wallet app's browser."),
      h("div.actions", {},
        h("a.btn", { href: "https://slush.app", target: "_blank", rel: "noreferrer" }, "Get Slush", icon("external")),
        h("button.btn.btn--light", { type: "button", onclick: () => renderWalletChoice(reconnect) }, "Look again")));
  }
  mount(modalBody,
    h("h2.wm-title#wallet-title", {}, reconnect ? "Reconnect your wallet" : "Connect a wallet"),
    h("p.wm-text", {}, intro),
    h("ul.wm-list", {}, list.map((wallet) => h("li", {},
      h("button.wm-option", { type: "button", onclick: () => (reconnect ? reconnectWith(wallet) : signInWith(wallet)) },
        h("img.wm-icon", { src: wallet.icon, alt: "" }),
        h("span.wm-name", {}, wallet.name),
        h("span.wm-detected", {}, "Detected"),
        icon("arrow"))))),
    h("p.fine", {}, "Signing in proves the address is yours. It does not move funds or let Edith spend."));
}

async function reconnectWith(wallet) {
  modalStage({ wallet, title: `Open ${wallet.name}`, text: "Approve the connection in your wallet.", busy: true });
  try {
    await wallets.connect(wallet);
    modal.close();
  } catch (err) {
    modalStage({ wallet, title: "Not connected", error: err.message, actions: [h("button.btn", { type: "button", onclick: () => renderWalletChoice(true) }, "Try again")] });
  }
}

async function signInWith(wallet) {
  const retry = h("button.btn", { type: "button", onclick: () => renderWalletChoice(false) }, "Try again");
  modalStage({ wallet, title: `Open ${wallet.name}`, text: "Approve the connection in your wallet.", busy: true });
  try {
    const address = await wallets.connect(wallet);
    modalStage({ wallet, title: "Sign to prove it's you", text: `Sign the message in ${wallet.name}. It proves you own ${shortAddress(address)}. It costs nothing and moves no funds.`, busy: true });
    const { message } = await api.challenge(address);
    const signature = await wallets.signMessage(message);
    modalStage({ wallet, title: "Checking your signature", text: "One moment.", busy: true });
    await api.signIn(message, signature);
    state.address = address;
    modal.close();
    await enter();
  } catch (err) {
    const text = err instanceof WalletError && err.declined ? "Nothing happened. You can try again whenever you like." : null;
    modalStage({ wallet, title: "Not signed in", text, error: err.message, actions: [retry] });
  }
}

/* Header */

function renderNav() {
  if (!state.address) return mount(nav);
  const waiting = (state.me?.activity ?? []).filter((a) => a.state === "awaiting").length;
  mount(nav, Object.entries(ROUTES).map(([path, route]) =>
    h("a.nav-tab", { href: path, onclick: go(path), "aria-current": location.pathname === path ? "page" : null, class: path === "/app/demo" ? "nav-tab--aside" : "" },
      route.title,
      path === "/app" && waiting ? h("span.count", { "aria-label": `${waiting} waiting for approval` }, String(waiting)) : null)));
}

function closeMenu() {
  const menu = account.querySelector(".menu");
  if (!menu || menu.hidden) return false;
  menu.hidden = true;
  account.querySelector(".account-btn")?.setAttribute("aria-expanded", "false");
  return true;
}

function renderAccount() {
  if (!state.address || !state.config) return mount(account);
  const menu = h("div.menu", { hidden: true },
    h("p.menu-label", {}, "Signed in as"),
    h("p.menu-address.mono", {}, state.address),
    h("p.menu-balance", {}, state.balance === null ? "Balance unavailable" : `${sui(state.balance)} SUI in this wallet`),
    h("div.menu-actions", {},
      h("button.menu-item", { type: "button", onclick: async () => {
        try {
          await navigator.clipboard.writeText(state.address);
          toast("Address copied.");
        } catch {
          toast("Couldn't copy. Select the address to copy it.");
        }
      } }, icon("copy"), "Copy address"),
      link(accountUrl(state.config.network, state.address), "View on Suiscan", "menu-item"),
      h("button.menu-item", { type: "button", onclick: signOut }, icon("out"), "Sign out")));
  const trigger = h("button.account-btn", { type: "button", "aria-expanded": "false", "aria-label": `Account ${shortAddress(state.address)}`, onclick: () => {
    const open = menu.hidden;
    menu.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
  } },
  wallets?.current?.icon ? h("img.account-icon", { src: wallets.current.icon, alt: "" }) : h("span.account-icon.account-icon--blank"),
  h("span.account-balance.mono", { title: state.balance === null ? null : `${sui(state.balance)} SUI` }, state.balance === null ? "–" : `${suiShort(state.balance)} SUI`),
  h("span.account-address.mono", {}, shortAddress(state.address)));
  mount(account, h("span.network", { title: `Sui ${state.config.network}` }, h("span.network-dot", { "aria-hidden": "true" }), state.config.network), h("div.account", {}, trigger, menu));
}

document.addEventListener("click", (e) => { if (!account.contains(e.target)) closeMenu(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && closeMenu()) account.querySelector(".account-btn")?.focus();
});

/* Screens */

function renderConnect() {
  document.title = "Edith";
  const cost = sui(BigInt(state.config.demo.priceMist) * 2n);
  mount(view,
    h("section.connect", { "aria-labelledby": "connect-title" },
      h("div.connect-copy", {},
        h("p.eyebrow", {}, "Edith for Sui"),
        h("h1.connect-title#connect-title", {}, "Your agent pays. ", h("span.soft", {}, "Never twice for the same mistake.")),
        h("p.connect-lede", {}, "Edith checks every paid API request against your limits and its memory of what went wrong before. Your wallet approves each payment."),
        h("div.actions", {}, h("button.btn.btn--icon", { type: "button", onclick: () => openWalletModal() }, h("span.btn-dots", { "aria-hidden": "true" }), "Connect wallet")),
        h("p.fine", {}, `Runs on Sui ${state.config.network}${state.config.network === "mainnet" ? " with real SUI" : ""}. The guided demo makes two payments of ${sui(state.config.demo.priceMist)} SUI (${cost} SUI in all) plus network fees.`)),
      h("ul.trust", {},
        trust("01", "Your keys stay in your wallet", "Edith never holds a private key or a seed phrase."),
        trust("02", "Signing in can't spend", "It proves the address is yours. That's all it does."),
        trust("03", "You approve every payment", "Each transfer appears in your wallet before you sign it, within limits you set."))));
}

const trust = (index, title, text) => h("li.trust-item", {}, h("span.trust-index.mono", { "aria-hidden": "true" }, index), h("p.trust-title", {}, title), h("p.trust-text", {}, text));

function render() {
  screen?.leave();
  screen = null;
  closeMenu();
  renderNav();
  renderAccount();
  if (!state.address) return renderConnect();
  const route = ROUTES[location.pathname] ?? ROUTES["/app"];
  document.title = `${route.title} · Edith`;
  view.classList.add("is-entering");
  clearTimeout(render.entering);
  render.entering = setTimeout(() => view.classList.remove("is-entering"), 900);
  screen = route.render(view, app);
  view.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

async function enter() {
  await wallets.reconnect();
  render();
  await refreshMe();
  startPolling();
  // An agent's approval link: /app?review=<id> opens that request for review.
  const review = new URLSearchParams(location.search).get("review");
  if (review) {
    history.replaceState({}, "", location.pathname);
    openDetail(app, review);
  }
}

function signedOut() {
  clearInterval(poll);
  state.address = null;
  state.me = null;
  state.balance = null;
  if (location.pathname !== "/app") history.replaceState({}, "", "/app");
  render();
}

async function signOut() {
  try {
    await api.signOut();
  } catch (err) {
    return toast(err.message);
  }
  await wallets.disconnect();
  signedOut();
  toast("Signed out.");
}

window.addEventListener("popstate", render);

async function boot() {
  try {
    [state.config, { address: state.address }] = await Promise.all([api.config(), api.session()]);
  } catch (err) {
    return mount(view, h("section.card.boot-error", { role: "alert" },
      h("h1.card-title", {}, "Edith can't load right now"),
      h("p.card-text", {}, err.message),
      h("button.btn", { type: "button", onclick: () => location.reload() }, "Try again")));
  }
  wallets = createWallets(state.config.network);
  wallets.onChange(renderAccount);
  if (state.address) await enter();
  else render();
}

boot();
