// A tiny element builder. Text is always set as text, never parsed as HTML.

// tag is "name.class.class#id": h("h2.card-title#guide-title").
export function h(tag, props = {}, ...children) {
  const [selector, id] = tag.split("#");
  const [name, ...classes] = selector.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  if (id) el.id = id;
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") el.className = [el.className, value].filter(Boolean).join(" ");
    else if (key === "style") el.style.cssText = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
}

// Inline icons, drawn on a 20px grid with a 1.6 stroke.
const PATHS = {
  check: "M5 10.5l3.2 3.2L15 7",
  cross: "M6 6l8 8M14 6l-8 8",
  arrow: "M4 10h12M11 5l5 5-5 5",
  external: "M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3M11 4h5v5M16 4l-7 7",
  copy: "M7 7h9v9H7zM13 4.5H5.5a1 1 0 0 0-1 1V13",
  refresh: "M16 10a6 6 0 1 1-1.8-4.3M16 3.5v3h-3",
  shield: "M10 3l6 2.5v4.2c0 3.6-2.5 6.3-6 7.3-3.5-1-6-3.7-6-7.3V5.5z",
  memory: "M4 6.5h12M4 10h8M4 13.5h12",
  clock: "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12zM10 7v3.2l2.2 1.4",
  wallet: "M3.5 6.5h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-12zM3.5 6.5l9-2.5v2.5M13 11h1.5",
  alert: "M10 4l7 12H3zM10 9v3M10 14.2v.1",
  close: "M5 5l10 10M15 5L5 15",
  out: "M8 4H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3M12 6.5L15.5 10 12 13.5M15.5 10H8",
};

export function icon(name, label) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("class", "icon");
  if (label) svg.setAttribute("aria-label", label);
  else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PATHS[name]);
  svg.append(path);
  return svg;
}

export const link = (href, text, cls = "link") => h(`a.${cls}`, { href, target: "_blank", rel: "noreferrer" }, text, icon("external"));
