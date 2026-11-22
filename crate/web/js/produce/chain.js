// The device chain along the bottom: the selected strip's effects in signal order, each a
// panel with its display and controls, as in Ableton's Device View. Drag effects in from the
// browser or along the chain (Ctrl-drag copies), click a panel to select it, Delete removes it.
import { h, icon, mount } from "../core/dom.js";
import { safe, toast } from "../core/api.js";
import { askSheet, menu } from "../core/ui.js";
import { knob, text } from "../perform/controls.js";
import { DRAG_TYPE, P, addDevice, drag, duplicateDevice, edit, owner, removeDevice, save, setParam, stripOfDevice, touch } from "./set.js";
import { DEVICES, eqHasGain } from "./fx/devices.js";
import { fmt, fromNorm, origin, parse, toNorm, valueOf } from "./fx/params.js";
import { BAND_COLOURS, VIEWS } from "./fx/views.js";
import { FACTORY, deleteUser, saveUser, userPresets } from "./fx/presets.js";
import { PANELS } from "./instruments/panels.js";

export function renderChain(el, W) {
  const o = owner(P.sel);
  if (!o) return mount(el, h("div", { class: "pd-drop" }, "Select a track to see its devices"));
  mount(el, ...o.devices.map((d) => panel(W, o, d)),
    h("div", { class: "pd-drop" }, o.devices.length ? "" : "Drop audio effects here, or double-click one in the browser"));
}

// ---- dropping: from the browser, or a panel moved along the chain or from another strip
const slotAt = (el, x) => {
  const panels = [...el.querySelectorAll(":scope > .dev")], i = panels.findIndex((p) => { const r = p.getBoundingClientRect(); return x < r.left + r.width / 2; });
  return [panels, i < 0 ? panels.length : i];
};
const movable = () => drag.item && (drag.item.kind === "device" || drag.item.kind === "move");
function mark(el, x) {
  const [panels, i] = slotAt(el, x);
  panels.forEach((p, k) => p.classList.toggle("ins", k === i));
  el.classList.toggle("ins-end", i === panels.length);
}
const unmark = (el) => { el.querySelectorAll(".ins").forEach((p) => p.classList.remove("ins")); el.classList.remove("ins-end"); };

export function chainDrop(el) {
  el.addEventListener("dragover", (e) => { if (!movable()) return; e.preventDefault(); e.dataTransfer.dropEffect = e.ctrlKey || e.altKey || drag.item.kind === "device" ? "copy" : "move"; mark(el, e.clientX); });
  el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) unmark(el); });
  el.addEventListener("drop", (e) => {
    const item = drag.item, o = owner(P.sel);
    unmark(el);
    if (!movable() || !o) return;
    e.preventDefault();
    const [, i] = slotAt(el, e.clientX);
    edit(() => {
      if (item.kind === "device") return addDevice(o, item.type, i, item.preset);
      const from = stripOfDevice(item.id), j = from.devices.findIndex((d) => d.id === item.id), d = from.devices[j];
      if (e.ctrlKey || e.altKey) { o.devices.splice(i, 0, { ...structuredClone(d), id: P.set.next_id++ }); return; }
      from.devices.splice(j, 1);
      o.devices.splice(from === o && j < i ? i - 1 : i, 0, d);
    });
  });
}

// ---- a device panel
function panel(W, o, d) {
  const def = DEVICES[d.type];
  if (!def) return h("section", { class: "dev missing" }, h("header", { class: "dev-head" }, h("span", { class: "dev-name" }, d.type)), h("p", {}, "This effect needs a newer version of Crate."));
  const view = !d.fold && def.view ? VIEWS[def.view](W, o, d) : null;
  const body = d.fold ? null : d.type === "eq"
    ? h("div", { class: "dev-body" }, h("div", { class: "eq-left" }, view, bandChips(W, o, d, def)), eqControls(W, o, d, def))
    : PANELS[d.type] ? h("div", { class: "dev-body inst" }, ...PANELS[d.type](W, o, d, def, (pf, size) => control(W, o, d, def, pf, size)))
      : h("div", { class: "dev-body" }, view, controls(W, o, d, def));
  const el = h("section", { class: "dev" + (d.on === false ? " off" : "") + (d.fold ? " fold" : "") + (def.instrument ? " instrument" : ""), "data-id": d.id,
    onpointerdown: () => { P.dev = d.id; P.clip = P.item = null; } }, head(o, d, def), body);
  let shown = null;
  W.add(el, () => { const v = P.dev === d.id; if (v !== shown) { shown = v; el.classList.toggle("sel", v); } });
  return el;
}

function head(o, d, def) {
  const name = d.name || def.name;
  return h("header", { class: "dev-head", draggable: "true",
    "data-help": `<b>${name}</b>  ${def.help}. Drag to move it, Ctrl-drag to copy, double-click to fold, right-click for presets`,
    ondblclick: (e) => { if (!e.target.closest("button")) edit(() => { d.fold = !d.fold; }); },
    oncontextmenu: (e) => { e.preventDefault(); deviceMenu(e, o, d, def); },
    ondragstart: (e) => { drag.item = { kind: "move", id: d.id }; e.dataTransfer.setData(DRAG_TYPE, "1"); e.dataTransfer.effectAllowed = "copyMove"; },
    ondragend: () => { drag.item = null; } },
  h("button", { class: "dev-on" + (d.on === false ? "" : " on"), "aria-label": `${name} on`, "data-help": `<b>Device on</b>  Off, the sound passes ${name} untouched`,
    onclick: () => edit(() => { d.on = d.on === false; }) }),
  h("span", { class: "dev-name" }, name, d.preset ? h("small", { class: "dev-preset" }, d.preset) : null),
  d.fold ? null : h("button", { class: "dev-ab" + (d.ab === "b" ? " b" : ""), "data-help": "<b>A/B</b>  Two sets of settings to compare. Click to switch; what you change goes to the one showing",
    onclick: () => edit(() => swapAB(d)) }, d.ab === "b" ? "B" : "A"),
  d.fold ? null : h("button", { class: "dev-more", "aria-label": "Device menu", onclick: (e) => deviceMenu(e, o, d, def) }, icon("i-chev", "i xs")));
}

function swapAB(d) {
  const other = d.alt ?? structuredClone(d.params);
  d.alt = d.params; d.params = other; d.ab = d.ab === "b" ? "a" : "b";
}

// a preset replaces the settings; on a return, the mix stays where it is unless the preset sets it
function loadPreset(d, params, name) {
  const mix = d.params.mix;
  d.params = { ...(mix != null ? { mix } : {}), ...structuredClone(params) };
  if (name) d.preset = name; else delete d.preset;
}
// presets by name, or for an instrument, kinds of preset each holding theirs
const isKind = (v) => Object.values(v).every((x) => x && typeof x === "object");

function deviceMenu(e, o, d, def) {
  const list = (src) => Object.entries(src).map(([n, v]) => (isKind(v) ? { label: n, sub: list(v) } : { label: n, icon: d.preset === n ? "i-check" : null, run: () => edit(() => loadPreset(d, v, n)) }));
  const factory = FACTORY[d.type] || {}, mine = userPresets(d.type), name = d.name || def.name;
  menu(e, [
    Object.keys(factory).length ? { label: "Presets", icon: "i-list", sub: list(factory) } : null,
    Object.keys(mine).length ? { label: "Your presets", icon: "i-heart", sub: list(mine) } : null,
    { label: "Save as preset…", run: safe(async () => {
      const n = await askSheet(`Save ${def.name} preset`, "", "Kept on this computer, under Your presets in this menu.");
      if (n) { saveUser(d.type, n, d.params); toast(`Saved ${n}`); }
    }) },
    Object.keys(mine).length ? { label: "Delete a preset", sub: Object.keys(mine).map((n) => ({ label: n, danger: true, run: () => { deleteUser(d.type, n); toast(`Deleted ${n}`); } })) } : null,
    { label: "Reset to defaults", run: () => edit(() => loadPreset(d, {})) },
    "-",
    { label: "Rename…", run: safe(async () => { const n = await askSheet("Rename device", name); if (n) edit(() => { d.name = n === def.name ? undefined : n; }); }) },
    { label: d.fold ? "Unfold" : "Fold", run: () => edit(() => { d.fold = !d.fold; }) },
    { label: "Duplicate", kbd: "Ctrl+D", icon: "i-copy", run: () => edit(() => duplicateDevice(o, d)) },
    "-",
    { label: "Delete", kbd: "Del", icon: "i-trash", danger: true, run: () => edit(() => removeDevice(o, d)) }]);
}

// ---- controls: switches and choosers in a column, then knobs, each with its value under it
function controls(W, o, d, def) {
  const v = Object.fromEntries(def.params.map((p) => [p.k, valueOf(p, d.params)])), shown = def.params.filter((p) => !p.when || p.when(v));
  const sw = shown.filter((p) => p.bool || p.opts), knobs = shown.filter((p) => !p.bool && !p.opts), c = (p) => control(W, o, d, def, () => p);
  return [sw.length ? h("div", { class: "dev-sw" }, ...sw.map(c)) : null, h("div", { class: "dev-ctl" }, ...knobs.map(c))];
}

// pf() gives the parameter, so one control can follow the EQ's selected band or a synth's
// selected operator
function control(W, o, d, def, pf, size = 34) {
  const p0 = pf(), get = () => valueOf(pf(), d.params);
  if (p0.bool) {
    const el = h("button", { class: "dk-tog", "data-help": `<b>${p0.n}</b>  ${def.name}`, onclick: () => edit(() => setParam(o, d, pf(), !get())) }, text(W, () => pf().n));
    let shown = null;
    W.add(el, () => { const v = !!get(); if (v !== shown) { shown = v; el.classList.toggle("on", v); } });
    return el;
  }
  if (p0.opts) {
    const pick = (e) => { const p = pf(); menu(e, p.opts.map((label, i) => ({ label, icon: i === get() ? "i-check" : null, run: () => edit(() => setParam(o, d, p, i)) }))); };
    return h("div", { class: "dk", "data-help": `<b>${p0.n}</b>  ${def.name}. Click to choose` },
      h("span", { class: "dk-n" }, p0.n), h("button", { class: "dk-opt", onclick: pick }, text(W, () => pf().opts[get()]), icon("i-chev", "i xs")));
  }
  const k = knob(W, p0.n, () => toNorm(pf(), get()), (n) => { touch(); setParam(o, d, pf(), fromNorm(pf(), n)); },
    { def: () => toNorm(pf(), pf().def), bipolar: origin(p0), size, help: `${def.name}. Drag, Shift for fine, double-click to reset. Double-click the value to type one` });
  const val = text(W, () => fmt(pf(), get()), "dk-v");
  val.addEventListener("dblclick", () => typeIn(val, o, d, pf));
  return h("div", { class: "dk" }, k, val);
}

function typeIn(el, o, d, pf) {
  const p = pf(), input = h("input", { class: "dk-in", value: fmt(p, valueOf(p, d.params)), "aria-label": p.n });
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = keep ? parse(p, input.value) : null;
    input.replaceWith(el);
    if (v != null) edit(() => setParam(o, d, p, v));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  el.replaceWith(input); input.focus(); input.select();
}

// ---- EQ Eight: band chips under the display; the selected band's controls beside it
const band = (d) => d.band || 3;

function bandChips(W, o, d, def) {
  return h("div", { class: "eq-bands" }, ...BAND_COLOURS.map((c, i) => {
    const b = i + 1, onP = def.byKey[`on${b}`];
    const el = h("button", { class: "eq-band", style: `--b:${c}`, "data-help": `<b>Band ${b}</b>  Click to select, double-click to switch on or off`,
      onclick: () => { d.band = b; save(); }, ondblclick: () => edit(() => setParam(o, d, onP, !valueOf(onP, d.params))) }, String(b));
    let shown = "";
    W.add(el, () => { const s = `${band(d) === b}|${valueOf(onP, d.params)}`; if (s !== shown) { shown = s; el.classList.toggle("sel", band(d) === b); el.classList.toggle("on", !!valueOf(onP, d.params)); } });
    return el;
  }));
}

function eqControls(W, o, d, def) {
  const bp = (k) => () => def.byKey[`${k}${band(d)}`], c = (pf) => control(W, o, d, def, pf);
  const gain = c(bp("g")), el = h("div", { class: "dev-ctl eq-ctl" }, c(bp("t")), c(bp("on")), c(() => def.byKey.out), c(bp("f")), gain, c(bp("q")));
  let shown = "";
  W.add(el, () => {
    const b = band(d), hasGain = eqHasGain(valueOf(def.byKey[`t${b}`], d.params)), s = `${b}|${hasGain}`;
    if (s === shown) return;
    shown = s; el.style.setProperty("--h", BAND_COLOURS[b - 1]); gain.classList.toggle("dim", !hasGain);
  });
  return el;
}
