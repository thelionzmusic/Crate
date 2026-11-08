// DOM helpers. h() builds elements; mount() replaces an element's children, skipping empties.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => el.querySelectorAll(s);

const clean = (kids) => kids.flat().filter((c) => c != null && c !== false && c !== "");

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of clean(kids)) e.append(c.nodeType ? c : String(c));
  return e;
}

export function mount(el, ...kids) { el.replaceChildren(...clean(kids).map((c) => (c.nodeType ? c : String(c)))); return el; }

const NS = "http://www.w3.org/2000/svg";
export function svg(tag, attrs = {}) { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; }
export function icon(name, cls = "i") { const s = svg("svg", { class: cls }); s.append(svg("use", { href: `#${name}` })); return s; }

// Element size in CSS pixels, kept current by one shared ResizeObserver, so per-frame
// drawing never reads layout (reading it after a DOM write forces a full reflow).
const sizes = new WeakMap();
const ro = new ResizeObserver((entries) => { for (const e of entries) sizes.set(e.target, [e.contentRect.width, e.contentRect.height]); });
export function watchSize(el) { sizes.set(el, [0, 0]); ro.observe(el); return el; }
export const sizeOf = (el) => sizes.get(el) || [0, 0];

export const typing = () => /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || "");
