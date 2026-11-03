import "./style.css";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Dot-matrix words type on, one character at a time ---------- */

function typeable(el, text) {
  el.textContent = "";
  [...text].forEach((char, c) => {
    const span = document.createElement("span");
    span.className = "ch";
    span.style.setProperty("--c", c);
    span.setAttribute("aria-hidden", "true");
    span.textContent = char;
    el.append(span);
  });
}

for (const el of document.querySelectorAll("[data-type]")) {
  if (!el.closest("[aria-hidden]")) el.setAttribute("aria-label", el.dataset.type);
  typeable(el, el.dataset.type);
}

/* ---------- Hero: wires draw, then packets run along them forever ---------- */

for (const path of document.querySelectorAll(".wire, .pulse")) path.setAttribute("pathLength", "1");
requestAnimationFrame(() => document.querySelector(".hero")?.classList.add("is-live"));

/* ---------- Scroll reveals and typed headings ---------- */

const revealer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("is-visible");
    if (entry.target.matches("[data-type]")) entry.target.classList.add("is-typed");
    revealer.unobserve(entry.target);
  }
}, { threshold: 0.18, rootMargin: "0px 0px -6% 0px" });
document.querySelectorAll("[data-reveal], .footer-word").forEach((el) => revealer.observe(el));

/* ---------- Nav steps aside while reading down ---------- */

const nav = document.querySelector("[data-nav]");
let lastY = window.scrollY;
window.addEventListener("scroll", () => {
  const y = window.scrollY;
  nav.classList.toggle("is-hidden", y > lastY && y > 240);
  lastY = y;
}, { passive: true });

/* ---------- Decision engine: how the policy treats each situation ---------- */

// Each case mirrors a rule in src/policy.mjs and src/edith.mjs. `flag` marks the check that decided it.
const CASES = [
  {
    checks: [["Request", "No record of this exact request"], ["Endpoint", "Most past calls here paid off"], ["Price", "Within the 0.005 SUI cap"]],
    verdict: "PAY", note: "Planned with payee, amount and reason, then settled on Sui once approved.",
  },
  {
    checks: [["Request", "Paid before, came back empty", true], ["Endpoint", "Otherwise healthy"], ["Price", "Within the cap"]],
    verdict: "DECLINE", note: "Junk is never paid for twice. The same request is refused before any payment.",
  },
  {
    checks: [["Request", "Last attempt returned a 5xx", true], ["Endpoint", "Failures look temporary"], ["Price", "Within the cap"]],
    verdict: "WAIT", note: "A fifteen-minute cool-down, then one retry. A provider's bad minute doesn't cost twice.",
  },
  {
    checks: [["Request", "No record of this exact request"], ["Endpoint", "Most past calls here paid off"], ["Price", "Over twice the price that last paid off", true]],
    verdict: "REFUSE", note: "A price spike is refused before any payment, however good the history.",
  },
  {
    checks: [["Request", "No record of this exact request"], ["Endpoint", "Most distinct requests here failed", true], ["Price", "Within the cap"]],
    verdict: "DECLINE", note: "New requests to an unreliable endpoint are declined. Requests that paid off before stay payable.",
  },
];
const CYCLE_MS = 5200;

const engine = document.querySelector("[data-engine]");
const tabs = [...engine.querySelectorAll("[data-case]")];
const checksEl = engine.querySelector("[data-checks]");
const verdictEl = engine.querySelector("[data-verdict]");
const noteEl = engine.querySelector("[data-verdict-note]");
const progress = engine.querySelector("[data-engine-progress]");
engine.style.setProperty("--cycle", `${CYCLE_MS}ms`);
let current = 0;
let timer = null;
let auto = !reduced;

function showCase(index) {
  current = index;
  const { checks, verdict, note } = CASES[index];
  tabs.forEach((tab, i) => {
    tab.setAttribute("aria-selected", String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
  });
  checksEl.innerHTML = checks.map(([key, value, flag], n) => `
    <li style="--n:${n}"><span class="check-key">${key}</span><span class="check-value">${value}</span><span class="check-mark${flag ? " is-flag" : ""}" aria-hidden="true"></span></li>`).join("");
  verdictEl.classList.toggle("is-hold", verdict !== "PAY");
  verdictEl.classList.remove("is-typed");
  typeable(verdictEl, verdict);
  verdictEl.setAttribute("aria-label", verdict);
  requestAnimationFrame(() => verdictEl.classList.add("is-typed"));
  noteEl.textContent = note;
  progress.classList.remove("is-running");
  if (auto) requestAnimationFrame(() => progress.classList.add("is-running"));
}

const stopAuto = () => { auto = false; clearInterval(timer); timer = null; progress.classList.remove("is-running"); };
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => { stopAuto(); showCase(i); });
  tab.addEventListener("keydown", (e) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    stopAuto();
    showCase((current + step + CASES.length) % CASES.length);
    tabs[current].focus();
  });
});
showCase(0);

new IntersectionObserver(([entry]) => {
  if (!auto) return;
  if (entry.isIntersecting && !timer) {
    showCase(current);
    timer = setInterval(() => showCase((current + 1) % CASES.length), CYCLE_MS);
  } else if (!entry.isIntersecting && timer) {
    clearInterval(timer);
    timer = null;
  }
}, { threshold: 0.35 }).observe(engine);

/* ---------- Five steps light up along a wire ---------- */

const steps = [...document.querySelectorAll("[data-step]")];
const wire = document.querySelector("[data-wire]");
const stepWatcher = new IntersectionObserver((entries) => {
  for (const entry of entries) if (entry.isIntersecting) entry.target.classList.add("is-on");
  wire?.style.setProperty("--p", String(steps.filter((s) => s.classList.contains("is-on")).length / steps.length));
}, { threshold: 0.6 });
steps.forEach((s, i) => { s.style.transitionDelay = `${i * 120}ms`; stepWatcher.observe(s); });

/* ---------- Code tabs ---------- */

const codeTabs = [...document.querySelectorAll("[data-code-tab]")];
codeTabs.forEach((tab) => tab.addEventListener("click", () => {
  codeTabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
  document.querySelectorAll("[data-code]").forEach((pre) => { pre.hidden = pre.dataset.code !== tab.dataset.codeTab; });
}));

/* ---------- Edith's mark in dots: three ledger rows, scanned like a memory being read ---------- */

function dotmark(canvas) {
  const ctx = canvas.getContext("2d");
  const rows = [
    { y: 0.22, x0: 0.14, x1: 0.86, mid: false },
    { y: 0.5, x0: 0.14, x1: 0.6, mid: true },
    { y: 0.78, x0: 0.14, x1: 0.86, mid: false },
  ];
  const half = 0.085;
  let dots = [];
  let width = 0;
  let height = 0;
  let visible = false;
  let frame = 0;

  const inRow = (ux, uy, r) => {
    if (Math.abs(uy - r.y) > half) return false;
    if (ux >= r.x0 && ux <= r.x1) return true;
    return Math.hypot(ux - (ux < r.x0 ? r.x0 : r.x1), uy - r.y) <= half;
  };

  function layout() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const size = Math.min(width, height) * 0.92;
    const ox = (width - size) / 2;
    const oy = (height - size) / 2;
    const gap = Math.max(7, size / 58);
    dots = [];
    for (let y = gap / 2; y < height; y += gap) {
      for (let x = gap / 2; x < width; x += gap) {
        const row = rows.find((r) => inRow((x - ox) / size, (y - oy) / size, r));
        if (!row && Math.random() > 0.01) continue;
        dots.push({ x, y, row, seed: Math.random() });
      }
    }
  }

  function draw(time) {
    ctx.clearRect(0, 0, width, height);
    for (const d of dots) {
      const scan = reduced ? 0 : Math.max(0, 1 - Math.abs(((time / 2600) % 1.4) - 0.2 - d.x / width) * 6);
      const shimmer = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(time / 900 + d.x * 0.03 + d.y * 0.045 + d.seed * 6);
      let r;
      if (!d.row) { ctx.fillStyle = "#b9c3d1"; r = 1; }
      else if (d.row.mid) { ctx.fillStyle = "#4da2ff"; r = 1.6 + shimmer * 1.2 + scan * 1.4; }
      else { ctx.fillStyle = scan > 0.3 ? "#4da2ff" : "#0b5bd3"; r = 1.5 + shimmer + scan * 1.4; }
      ctx.beginPath();
      ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const loop = (time) => {
    draw(time);
    if (visible && !reduced) frame = requestAnimationFrame(loop);
  };

  layout();
  draw(0);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    cancelAnimationFrame(frame);
    if (visible && !reduced) frame = requestAnimationFrame(loop);
  }).observe(canvas);
  new ResizeObserver(() => { layout(); draw(performance.now()); }).observe(canvas);
}
document.querySelectorAll("[data-dotmark]").forEach(dotmark);
