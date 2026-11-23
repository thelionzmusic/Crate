// Synth editors: a Crate instrument in its own window over the set, as a plug-in's is. Serum's
// frame: a header with the pages, the preset (browse, step, save), A/B, undo, the main level and
// its meter; the synth's page; a keyboard to play it along the foot. Several can be open, each
// dragged by its header and scaled from its corner; they live until closed or their device goes.
import { h, icon } from "../../core/dom.js";
import { safe } from "../../core/api.js";
import { menu } from "../../core/ui.js";
import { Widgets, text } from "../../perform/controls.js";
import { P, edit, inKey, keyName, nameOf, save, step, stripOfDevice } from "../set.js";
import { studio } from "../engine.js";
import { DEVICES } from "../fx/devices.js";
import { control, loadPreset, presetItems, presetList, savePreset, swapAB } from "../control.js";
import { PAGES, kit } from "./pages.js";

const WIDTH = 1180, HEIGHT = 724, LOWEST = 24, OCTAVES = 5;  // the page's own size, before scaling
const open = new Map();  // device id → editor
let top = 100;
const prefScale = () => { try { return +localStorage.getItem("synthScale") || 0; } catch { return 0; } };
const keepScale = (s) => { try { localStorage.setItem("synthScale", String(s)); } catch { /* fine without */ } };

export function openEditor(o, d) {
  const ed = open.get(d.id);
  if (ed) { raise(ed); return; }
  const fit = Math.min(1, (innerWidth - 60) / WIDTH, (innerHeight - 90) / HEIGHT), scale = Math.max(0.55, Math.min(fit, prefScale() || fit));
  const n = open.size, x = Math.max(8, (innerWidth - WIDTH * scale) / 2 + n * 28), y = Math.max(8, (innerHeight - HEIGHT * scale) / 2 + n * 28);
  // the frame sits where it's put, in screen pixels; what's in it is scaled
  const inner = h("div", { class: "sx-in", style: `zoom:${scale}` });
  const el = h("div", { class: "sx", role: "dialog", "aria-label": DEVICES[d.type].name, tabindex: "-1", style: `left:${x}px;top:${y}px` }, inner);
  const e = { id: d.id, o, d, el, inner, scale, W: new Widgets(), held: new Map() };
  open.set(d.id, e);
  document.body.append(el);
  build(e); raise(e);
}

function closeEditor(id) {
  const e = open.get(id);
  if (!e) return;
  for (const off of e.held.values()) off();
  e.el.remove(); open.delete(id);
}

// each frame, from Produce's loop
export function syncEditors() { for (const e of open.values()) e.W.sync(); }

// after an edit: a device that's gone closes its window; one replaced (undo, a reload) is rebuilt
export function refreshEditors() {
  for (const e of [...open.values()]) {
    const o = stripOfDevice(e.id), d = o?.devices.find((x) => x.id === e.id);
    if (!d || !DEVICES[d.type]?.instrument) { closeEditor(e.id); continue; }
    if (d !== e.d || o !== e.o) { e.o = o; e.d = d; build(e); }
  }
}

const raise = (e) => { e.el.style.zIndex = String(++top); };

function build(e) {
  const { o, d } = e, def = DEVICES[d.type], spec = PAGES[d.type];
  const W = e.W = new Widgets(), x = kit(W, o, d, def, (pf, size) => control(W, o, d, def, pf, size));
  const tab = () => spec.tabs.find(([t]) => t === d.tab) || spec.tabs[0];
  const pages = spec.tabs.map(([t, , make]) => { const pg = h("main", { class: "sx-page" }, ...make(x)); W.add(pg, () => pg.classList.toggle("gone", tab()[0] !== t)); return pg; });
  e.inner.replaceChildren(header(e, def, spec), ...pages, keyboard(e, x, spec), grip(e));
  e.el.onpointerdown = () => raise(e);
  e.el.onkeydown = (ev) => { if (ev.key === "Escape") closeEditor(e.id); };
}

// ---- the header
function header(e, def, spec) {
  const { o, d, W } = e;
  const tabs = spec.tabs.length > 1 ? h("nav", { class: "sx-pages" }, ...spec.tabs.map(([t, label]) => {
    const b = h("button", { class: "sx-ptab", onclick: () => { d.tab = t; save(); } }, label);
    W.add(b, () => b.classList.toggle("on", (d.tab ?? spec.tabs[0][0]) === t));
    return b;
  })) : null;
  // the preset: its name, stepped with the arrows, chosen from the menu
  const go = (by) => {
    const list = presetList(d.type);
    if (!list.length) return;
    const at = list.findIndex(([, n]) => n === d.preset), [, n, params] = list[(at + by + list.length) % list.length];
    edit(() => loadPreset(d, params, n));
  };
  const kind = () => presetList(d.type).find(([, n]) => n === d.preset)?.[0] || "";
  const preset = h("div", { class: "sx-preset" },
    h("div", { class: "sx-pline" },
      h("button", { class: "sx-ib", "aria-label": "Presets", "data-help": "<b>Presets</b>  Browse the factory presets and your own", onclick: (ev) => menu(ev, presetItems(d, def)) }, icon("i-folder", "i sm")),
      h("button", { class: "sx-pname", onclick: (ev) => menu(ev, presetItems(d, def)) }, text(W, () => d.preset || "Init"), icon("i-chev", "i xs")),
      h("button", { class: "sx-ib", "aria-label": "Previous preset", onclick: () => go(-1) }, "‹"),
      h("button", { class: "sx-ib", "aria-label": "Next preset", onclick: () => go(1) }, "›")),
    h("div", { class: "sx-pmeta" }, text(W, () => kind()), text(W, () => `on ${nameOf(o)}`)));
  const ab = h("button", { class: "sx-btn", "data-help": "<b>A/B</b>  Two sets of settings to compare. What you change goes to the one showing", onclick: () => edit(() => swapAB(d)) }, text(W, () => (d.ab === "b" ? "B" : "A")));
  const meter = h("div", { class: "sx-meter" }, h("i"), h("i"));
  W.add(meter, () => {
    const lr = studio.device(o, d.id)?.out?.() || [0, 0];
    lr.forEach((v, i) => { meter.children[i].style.transform = `scaleY(${Math.max(0, Math.min(1, (20 * Math.log10(v || 1e-9) + 48) / 54))})`; });
  });
  const head = h("header", { class: "sx-head" },
    h("div", { class: "sx-brand" }, h("b", {}, "C"), h("span", {}, def.name.replace("Crate ", ""))),
    tabs || h("div", { class: "sx-pages" }),
    preset,
    h("button", { class: "sx-ib star", "aria-label": "Save preset", "data-help": "<b>Save preset</b>  Keep these settings under Your presets", onclick: safe(() => savePreset(d, def)) }, "★"),
    ab,
    h("div", { class: "sx-undo" },
      h("button", { class: "sx-ib", "aria-label": "Undo", "data-help": "<b>Undo</b>  Ctrl+Z", onclick: () => step(true) }, "↶"),
      h("button", { class: "sx-ib", "aria-label": "Redo", "data-help": "<b>Redo</b>  Ctrl+Shift+Z", onclick: () => step(false) }, "↷")),
    h("div", { class: "sx-main" }, control(W, o, d, def, () => def.byKey.level, 40)),
    meter,
    h("button", { class: "sx-ib close", "aria-label": "Close", onclick: () => closeEditor(e.id) }, icon("i-x", "i sm")));
  // dragged by anything in it that isn't a control
  head.addEventListener("pointerdown", (ev) => {
    if (ev.button || ev.target.closest("button, .knob, .dk, input")) return;
    ev.preventDefault(); head.setPointerCapture(ev.pointerId);
    const el = e.el, sx = ev.clientX - el.offsetLeft, sy = ev.clientY - el.offsetTop;
    const move = (m) => {
      el.style.left = `${Math.max(120 - el.offsetWidth, Math.min(innerWidth - 120, m.clientX - sx))}px`;
      el.style.top = `${Math.max(0, Math.min(innerHeight - 40, m.clientY - sy))}px`;
    };
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
  });
  return head;
}

// the corner: drag to scale the whole window, keeping its look
function grip(e) {
  const g = h("i", { class: "sx-grip", "data-help": "<b>Size</b>  Drag to make the window bigger or smaller" });
  g.addEventListener("pointerdown", (ev) => {
    if (ev.button) return;
    ev.preventDefault(); ev.stopPropagation(); g.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX, s0 = e.scale;
    const move = (m) => { e.scale = Math.max(0.5, Math.min(1.6, s0 + (m.clientX - x0) / WIDTH)); e.inner.style.zoom = String(e.scale); };
    const up = () => { g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); keepScale(e.scale); };
    g.addEventListener("pointermove", move); g.addEventListener("pointerup", up);
  });
  return g;
}

// ---- the keyboard: five octaves to play the synth, sliding across for a run; higher on a key
// is softer. The set's key marks its notes. The octave arrows move it; beside it, the synth's
// tuning and glide.
function keyboard(e, x, spec) {
  const { o, W } = e;
  let low = LOWEST + 12;
  const keys = h("div", { class: "sx-kb" });
  const draw = () => {
    keys.replaceChildren();
    for (let p = low; p < low + OCTAVES * 12 + 1; p++) {
      const black = [1, 3, 6, 8, 10].includes(p % 12);
      keys.append(h("i", { class: black ? "bk" : "wk", "data-p": p }, p % 12 === 0 ? h("span", {}, `C${p / 12 - 2}`) : null));
    }
  };
  draw();
  W.add(keys, () => {
    const k = P.set.key, sig = `${low}|${k ? k.root + k.scale : ""}`;
    if (keys.dataset.sig === sig) return;
    keys.dataset.sig = sig;
    for (const el of keys.children) el.classList.toggle("ink", !!k && inKey(+el.dataset.p));
  });
  const play = (el, ev) => {
    const p = +el.dataset.p, r = el.getBoundingClientRect(), vel = Math.max(0.3, Math.min(1, 0.3 + 0.7 * (ev.clientY - r.top) / r.height));
    e.held.set(p, studio.hold(o, p, vel)); el.classList.add("on");
  };
  const stop = (p) => { e.held.get(p)?.(); e.held.delete(p); keys.querySelector(`[data-p="${p}"]`)?.classList.remove("on"); };
  keys.addEventListener("pointerdown", (ev) => {
    const el = ev.target.closest("[data-p]");
    if (ev.button || !el) return;
    ev.preventDefault(); keys.setPointerCapture(ev.pointerId);
    let cur = el; play(el, ev);
    const move = (m) => {
      const at = document.elementFromPoint(m.clientX, m.clientY)?.closest?.(".sx-kb [data-p]");
      if (!at || at === cur) return;
      stop(+cur.dataset.p); cur = at; play(at, m);
    };
    const up = () => { stop(+cur.dataset.p); keys.removeEventListener("pointermove", move); keys.removeEventListener("pointerup", up); keys.removeEventListener("pointercancel", up); };
    keys.addEventListener("pointermove", move); keys.addEventListener("pointerup", up); keys.addEventListener("pointercancel", up);
  });
  const shift = (by) => { low = Math.max(0, Math.min(96, low + by * 12)); draw(); keys.dataset.sig = ""; };
  return h("footer", { class: "sx-foot" },
    h("div", { class: "sx-oct" },
      h("button", { class: "sx-ib", "aria-label": "Octave down", onclick: () => shift(-1) }, "‹"),
      text(W, () => `C${low / 12 - 2}`, "sx-octv"),
      h("button", { class: "sx-ib", "aria-label": "Octave up", onclick: () => shift(1) }, "›")),
    h("div", { class: "sx-keyinfo", "data-help": "<b>Key</b>  The set's key, from the transport. Its notes are marked on the keyboard" },
      h("small", {}, "Key"), text(W, () => keyName(P.set.key)), h("small", {}, "Scale"), text(W, () => (P.set.key ? (P.set.key.scale === "minor" ? "Minor" : "Major") : "–"))),
    keys,
    h("div", { class: "sx-tune" }, ...spec.foot.map((k) => x.c(k))));
}
