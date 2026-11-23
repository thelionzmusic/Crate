// A device parameter as a control, and a device's presets: shared by the device chain and the
// synth editors, so a knob, a switch or a preset behaves the same in either.
import { h, icon } from "../core/dom.js";
import { safe, toast } from "../core/api.js";
import { askSheet, menu } from "../core/ui.js";
import { knob, text } from "../perform/controls.js";
import { edit, setParam, touch } from "./set.js";
import { fmt, fromNorm, origin, parse, toNorm, valueOf } from "./fx/params.js";
import { FACTORY, deleteUser, saveUser, userPresets } from "./fx/presets.js";

// pf() gives the parameter, so one control can follow the EQ's selected band or a synth's
// selected operator
export function control(W, o, d, def, pf, size = 34) {
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

// ---- A/B and presets
export function swapAB(d) {
  const other = d.alt ?? structuredClone(d.params);
  d.alt = d.params; d.params = other; d.ab = d.ab === "b" ? "a" : "b";
}

// a preset replaces the settings; on a return, the mix stays where it is unless the preset sets it
export function loadPreset(d, params, name) {
  const mix = d.params.mix;
  d.params = { ...(mix != null ? { mix } : {}), ...structuredClone(params) };
  if (name) d.preset = name; else delete d.preset;
}
// presets by name, or for an instrument, kinds of preset each holding theirs
const isKind = (v) => Object.values(v).every((x) => x && typeof x === "object");

// every factory preset in menu order, as [kind, name, params], for stepping through
export function presetList(type) {
  const out = [], walk = (src, kind) => Object.entries(src).forEach(([n, v]) => (isKind(v) ? walk(v, n) : out.push([kind, n, v])));
  walk(FACTORY[type] || {}, ""); walk(userPresets(type), "Your presets");
  return out;
}

export async function savePreset(d, def) {
  const n = await askSheet(`Save ${def.name} preset`, d.preset || "", "Kept on this computer, under Your presets.");
  if (n) { saveUser(d.type, n, d.params); edit(() => { d.preset = n; }); toast(`Saved ${n}`); }
}

// the presets part of a device's menu
export function presetItems(d, def) {
  const list = (src) => Object.entries(src).map(([n, v]) => (isKind(v) ? { label: n, sub: list(v) } : { label: n, icon: d.preset === n ? "i-check" : null, run: () => edit(() => loadPreset(d, v, n)) }));
  const factory = FACTORY[d.type] || {}, mine = userPresets(d.type);
  return [
    Object.keys(factory).length ? { label: "Presets", icon: "i-list", sub: list(factory) } : null,
    Object.keys(mine).length ? { label: "Your presets", icon: "i-heart", sub: list(mine) } : null,
    { label: "Save as preset…", run: safe(() => savePreset(d, def)) },
    Object.keys(mine).length ? { label: "Delete a preset", sub: Object.keys(mine).map((n) => ({ label: n, danger: true, run: () => { deleteUser(d.type, n); toast(`Deleted ${n}`); } })) } : null,
    { label: "Reset to defaults", run: () => edit(() => loadPreset(d, {})) }];
}
