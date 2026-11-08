// Hardware-style controls. Every widget reads and writes through get/set, and registers a
// sync function that updates it only when its value actually changed, so the per-frame
// refresh touches the DOM only for things that moved.
import { h, sizeOf, svg, watchSize } from "../core/dom.js";
import { CanvasText } from "../core/canvastext.js";

export class Widgets {
  constructor() { this.list = []; }
  add(el, sync) { this.list.push(sync); return el; }
  sync() { for (const s of this.list) s(); }
  clear() { this.list = []; }
}

function drag(el, onMove, { axis = "y", reset, skip } = {}) {
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || (skip && e.target.closest(skip))) return;
    e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add("held");
    let last = axis === "y" ? e.clientY : e.clientX;
    const move = (ev) => { const v = axis === "y" ? ev.clientY : ev.clientX; onMove(v - last, ev); last = v; };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.classList.remove("held"); };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
  });
  if (reset) el.addEventListener("dblclick", reset);
}
export { drag };

// rotary knob: drag up/down (Shift for fine), wheel, double-click resets.
// Bipolar knobs light from the centre; kill knobs toggle off when their label is clicked.
export function knob(W, label, get, set, { def = 0.5, bipolar = true, help = "", size = 34, kill = false } = {}) {
  const r = 13, c = 2 * Math.PI * r, arcLen = c * 0.75;
  const s = svg("svg", { viewBox: "0 0 34 34", width: size, height: size, class: "knob-svg" });
  const val = svg("circle", { cx: 17, cy: 17, r, class: "kv" }), tick = svg("line", { x1: 17, y1: 17, x2: 17, y2: 9, class: "kp" });
  s.append(svg("circle", { cx: 17, cy: 17, r, class: "kt", "stroke-dasharray": `${arcLen} ${c}`, transform: "rotate(135 17 17)" }), val, svg("circle", { cx: 17, cy: 17, r: 9.5, class: "kc" }), tick);
  const name = h("span", {}, label);
  const el = h("div", { class: "knob", "data-help": `<b>${label}</b>  ${help || "Drag up or down. Double-click to reset"}` }, s, name);
  let shown = null;
  W.add(el, () => {
    const v = get(); if (v === shown) return; shown = v;
    const from = bipolar ? 0.5 : 0, a = Math.min(from, v), b = Math.max(from, v);
    val.setAttribute("stroke-dasharray", `${(b - a) * arcLen} ${c}`); val.setAttribute("transform", `rotate(${135 + a * 270} 17 17)`);
    tick.setAttribute("transform", `rotate(${-135 + v * 270} 17 17)`);
    el.classList.toggle("off", kill && v < 0.02);
  });
  drag(el, (dy, ev) => set(get() - dy * (ev.shiftKey ? 0.0015 : 0.006)), { reset: () => set(def), skip: kill ? "span" : null });
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(get() - Math.sign(e.deltaY) * 0.02); }, { passive: false });
  if (kill) name.addEventListener("click", () => set(get() < 0.02 ? def : 0));
  return el;
}

// fader, vertical or horizontal; invert for CDJ-style tempo (down is faster)
export function fader(W, get, set, { axis = "y", def = 0, help = "", cls = "", invert = false, centre = false } = {}) {
  const cap = h("i", { class: "cap" }), el = h("div", { class: `fader ${axis} ${cls}`, "data-help": help }, h("b", { class: "groove" }), centre ? h("b", { class: "detent" }) : null, cap);
  let shown = null;
  W.add(el, () => {
    const v = get(); if (v === shown) return; shown = v;
    const k = invert ? 1 - v : v; cap.style[axis === "y" ? "top" : "left"] = `${(axis === "y" ? 1 - k : k) * 100}%`;
  });
  watchSize(el);
  drag(el, (d, ev) => {
    const [w, hh] = sizeOf(el), len = axis === "y" ? hh : w, sign = axis === "y" ? -1 : 1;
    set(get() + (invert ? -1 : 1) * sign * d / len * (ev.shiftKey ? 0.15 : 1));
  }, { axis, reset: () => set(def) });
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(get() - Math.sign(e.deltaY) * 0.01 * (invert ? -1 : 1) * (axis === "y" ? 1 : -1)); }, { passive: false });
  return el;
}

// button that acts on press (not release), like hardware; on() returns true, false or "blink"
export function pbtn(W, label, onDown, { cls = "", help = "", onUp, on } = {}) {
  const el = h("button", { class: `pbtn ${cls}`, "data-help": help }, label);
  el.addEventListener("pointerdown", (e) => { if (e.button === 0) { el.setPointerCapture(e.pointerId); onDown(e); } });
  if (onUp) el.addEventListener("pointerup", onUp);
  if (on) { let shown = null; W.add(el, () => { const v = on(); if (v !== shown) { shown = v; el.classList.toggle("on", !!v); el.classList.toggle("blink", v === "blink"); } }); }
  return el;
}

// live text
export function text(W, fn, cls = "") {
  const el = h("span", { class: cls }); let shown = null;
  W.add(el, () => { const v = fn(); if (v !== shown) { shown = v; el.textContent = v; } });
  return el;
}

// fast-changing text (clocks) on a canvas, so ticking never triggers a page layout
export function clockText(W, fn, cls = "") {
  const c = h("canvas", { class: `ctext ${cls}` }), t = new CanvasText(c);
  W.add(c, () => t.set(fn()));
  return c;
}

// segmented LED meter with peak hold; redraws only when a segment changes
export function vu(W, level) {
  const c = watchSize(h("canvas", { class: "vu" })), n = 18;
  let peak = 0, hold = 0, drawn = "";
  W.add(c, () => {
    const [cw, ch] = sizeOf(c), w = Math.round(cw * devicePixelRatio), H = Math.round(ch * devicePixelRatio); if (!w || !H) return;
    const v = level(), db = v > 0 ? 20 * Math.log10(v) : -90, k = Math.max(0, Math.min(1, (db + 36) / 36));
    if (k >= peak) { peak = k; hold = 40; } else if (--hold < 0) peak = Math.max(0, peak - 0.015);
    const lit = Math.round(k * n), pk = Math.min(n - 1, Math.floor(peak * n)), sig = `${w}|${H}|${lit}|${pk}`;
    if (sig === drawn) return; drawn = sig;
    if (c.width !== w || c.height !== H) { c.width = w; c.height = H; }
    const g = c.getContext("2d"), seg = H / n;
    g.clearRect(0, 0, w, H);
    for (let i = 0; i < n; i++) {
      const f = i / n, on = i < lit || (i === pk && peak > 0.02);
      g.fillStyle = on ? (f > 0.88 ? "#ff5b4f" : f > 0.7 ? "#ffb13b" : "#4ee08a") : "rgba(255,255,255,.07)";
      g.fillRect(0, H - (i + 1) * seg + 1, w, seg - 2);
    }
  });
  return c;
}
