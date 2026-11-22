// Clip view: one column per track (title bar, clip slots, mixer at the foot), the return
// tracks, then Main with the scene launchers. Built once per edit; what plays, what's queued
// and which strip is selected are synced per frame.
import { h, icon, mount } from "../core/dom.js";
import { askSheet, menu } from "../core/ui.js";
import { safe } from "../core/api.js";
import { drag as dragBy, knob, vu } from "../perform/controls.js";
import { UNITY, gainOf, studio } from "./engine.js";
import { P, addDevice, addReturn, addTrack, drag, edit, keyOf, makeClip, mixAll, nameOf, remix, removeReturn, removeTrack, save, touch } from "./set.js";

export function renderClips(el, W) {
  const s = P.set;
  mount(el,
    ...s.tracks.map((t) => column(t, W)),
    h("div", { class: "pc-drop", ...dropTo(() => addTrack("audio"), (clip) => { const t = addTrack("audio", clip.name); t.clips[0] = clip; }) },
      h("span", {}, "Drop files and effects here")),
    ...s.returns.map((r) => returnColumn(r, W)),
    mainColumn(W));
}

function column(t, W) {
  const slots = [];
  for (let i = 0; i < P.set.scenes; i++) slots.push(slot(t, i, W));
  return selectable(W, t.id, h("div", { class: "pc-track", style: `--c:${t.colour}`, ...dropTo(() => t) },
    trackHead(t),
    h("div", { class: "pc-slots" }, ...slots,
      h("button", { class: "pc-stop", "data-help": "<b>Stop</b>  Stops this track's clip at the next bar", onclick: () => studio.stopTrack(t) }, icon("i-stop", "i sm"))),
    h("div", { class: "pc-fill" }),
    mixFoot(t, W)));
}

// the strip whose devices show below is marked per frame, so selecting never rebuilds
export function selectable(W, key, el) {
  let shown = null;
  return W.add(el, () => { const v = P.sel === key; if (v !== shown) { shown = v; el.classList.toggle("sel", v); } });
}

// a strip's title bar: click selects it, double-click renames, right-click for more
function head(o, items) {
  return h("div", { class: "pc-head", "data-help": `<b>${nameOf(o)}</b>  Click to show its devices${items ? ", double-click to rename, right-click for more" : ""}`,
    onpointerdown: () => { P.sel = keyOf(o); },
    ondblclick: items ? () => rename(o) : null,
    oncontextmenu: items ? (e) => { e.preventDefault(); menu(e, items); } : null },
  h("span", {}, nameOf(o)));
}
const rename = safe(async (o) => { const v = await askSheet("Rename", o.name); if (v) edit(() => { o.name = v; }); });
const newReturn = { label: "Insert return track", kbd: "Ctrl+Alt+T", run: () => edit(addReturn) };
export const trackHead = (t) => head(t, [{ label: "Rename", run: () => rename(t) }, newReturn, "-", { label: "Delete track", danger: true, run: () => edit(() => removeTrack(t)) }]);

function slot(t, i, W) {
  const clip = t.clips[i];
  const el = h("div", { class: "pc-slot" + (clip ? " full" : ""), ...dropTo(() => t, (c) => { t.clips[i] = c; P.clip = [t.id, i]; }) });
  if (!clip) {
    el.append(icon("i-stop", "i xs"));
    el.addEventListener("click", () => { studio.stopTrack(t); P.clip = [t.id, i]; });
    return el;
  }
  el.draggable = true;
  el.append(icon("i-play", "i xs fill"), h("span", {}, clip.name), h("b", { class: "pc-prog" }));
  el.addEventListener("click", () => { studio.launch(t, clip); P.clip = [t.id, i]; });
  el.addEventListener("dragstart", (e) => { drag.item = { kind: "clip", clip }; e.dataTransfer.setData("text/crate-produce", "1"); });
  el.addEventListener("dragend", () => { drag.item = null; });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu(e, [
      { label: "Rename", run: safe(async () => { const v = await askSheet("Rename clip", clip.name); if (v) edit(() => { clip.name = v; }); }) },
      { label: clip.loop ? "Play once" : "Loop", run: () => edit(() => { clip.loop = !clip.loop; }) },
      { label: "Duplicate", run: () => edit(() => { let j = i + 1; while (t.clips[j]) j++; t.clips[j] = structuredClone(clip); P.set.scenes = Math.max(P.set.scenes, j + 1); }) },
      "-", { label: "Delete", danger: true, run: () => edit(() => { delete t.clips[i]; }) }]);
  });
  let shown = "";
  const prog = el.lastChild;
  W.add(el, () => {
    const st = studio.state(t), on = st.playing === clip, q = st.queued?.clip === clip;
    const sel = P.clip && P.clip[0] === t.id && P.clip[1] === i, sig = `${on}${q}${sel}`;
    if (sig !== shown) { shown = sig; el.classList.toggle("playing", on); el.classList.toggle("queued", q); el.classList.toggle("on", sel); }
    if (on) prog.style.transform = `scaleX(${clip.loop ? (((studio.beatNow() - st.start) % clip.beats) + clip.beats) % clip.beats / clip.beats : 1})`;
  });
  return el;
}

// A drop target. An effect from the browser goes onto strip(); anything else becomes a clip
// handed to put(), when there is one. Either way it's one edit.
function dropTo(strip, put) {
  const takes = (it) => it && (it.kind === "device" ? !!strip : it.kind !== "move" && !!put);
  return {
    ondragover: (e) => { if (takes(drag.item)) { e.preventDefault(); e.stopPropagation(); e.currentTarget.classList.add("drop"); } },
    ondragleave: (e) => e.currentTarget.classList.remove("drop"),
    ondrop: safe(async (e) => {
      const item = drag.item;
      e.currentTarget.classList.remove("drop");
      if (!takes(item)) return;
      e.preventDefault(); e.stopPropagation();
      if (item.kind === "device") return edit(() => { const o = strip(); addDevice(o, item.type); P.sel = keyOf(o); });
      const clip = await makeClip(item);
      edit(() => put(clip));
    }),
  };
}

// ---- the mixer: activator, solo, sends, volume in dB, pan, meter
function mixFoot(t, W) {
  return h("div", { class: "pc-mix" },
    h("div", { class: "pc-mixrow" }, ...trackToggles(W, t)),
    P.set.returns.length ? h("div", { class: "pc-mixrow pc-sends" }, ...P.set.returns.map((r) => sendKnob(W, t, r))) : null,
    h("div", { class: "pc-mixrow" }, stripVol(W, t), panKnob(W, t)),
    vu(W, () => studio.track(t).meter()));
}

function returnColumn(r, W) {
  return selectable(W, r.id, h("div", { class: "pc-track pc-return", style: `--c:${r.colour}`, ...dropTo(() => r) },
    head(r, [{ label: "Rename", run: () => rename(r) }, newReturn, "-", { label: "Delete return track", danger: true, run: () => edit(() => removeReturn(r)) }]),
    h("div", { class: "pc-fill" }),
    h("div", { class: "pc-mix" },
      h("div", { class: "pc-mixrow" }, toggle(W, r.id, () => !r.mute, () => { touch(); r.mute = !r.mute; remix(r); save(); }, "act", "<b>Return on</b>  Click to mute")),
      h("div", { class: "pc-mixrow" }, stripVol(W, r), panKnob(W, r)),
      vu(W, () => studio.ret(r).meter()))));
}

// shared with the timeline's track headers
export const trackToggles = (W, t) => [
  toggle(W, String(P.set.tracks.indexOf(t) + 1), () => !t.mute, () => { touch(); t.mute = !t.mute; mixAll(); save(); }, "act", "<b>Track on</b>  Click to mute"),
  toggle(W, "S", () => t.solo, () => { touch(); t.solo = !t.solo; mixAll(); save(); }, "solo", "<b>Solo</b>")];
export const stripVol = (W, o) => volBox(W, () => o.volume, (v) => { touch(); o.volume = v; remix(o); save(); });

const panKnob = (W, o) => knob(W, "Pan", () => ((o.pan || 0) + 1) / 2,
  (v) => { touch(); o.pan = Math.round((Math.min(1, Math.max(0, v)) * 2 - 1) * 50) / 50; remix(o); save(); },
  { size: 26, help: "Drag up or down. Double-click to centre" });

// a post-fader send on a fader's scale: 85% round is 0 dB, fully left is off
const sendKnob = (W, t, r) => knob(W, r.id, () => t.sends[r.id] ?? 0,
  (v) => { touch(); t.sends[r.id] = Math.min(1, Math.max(0, v)); remix(t); save(); },
  { size: 22, bipolar: false, def: 0, help: `Send to ${r.name}, after the fader. Double-click turns it off` });

function mainColumn(W) {
  const s = P.set, scenes = [];
  for (let i = 0; i < s.scenes; i++) {
    scenes.push(h("button", { class: "pc-scene", "data-help": "<b>Scene</b>  Launches this row across every track", onclick: () => launchScene(i) },
      icon("i-play", "i xs fill"), h("span", {}, String(i + 1))));
  }
  return selectable(W, "main", h("div", { class: "pc-track pc-main", ...dropTo(() => s.main) },
    head(s.main, null),
    h("div", { class: "pc-slots" }, ...scenes,
      h("button", { class: "pc-stop", "data-help": "<b>Stop all clips</b>", onclick: () => studio.stopAll() }, icon("i-stop", "i sm"), h("span", {}, "Stop all"))),
    h("div", { class: "pc-fill" }),
    h("div", { class: "pc-mix" },
      h("div", { class: "pc-mixrow" }, h("button", { class: "pbtn", onclick: () => edit(() => { s.scenes++; }) }, "+ Scene")),
      h("div", { class: "pc-mixrow" }, stripVol(W, s.main)),
      vu(W, () => studio.mainMeter()))));
}

function launchScene(i) {
  for (const t of P.set.tracks) { const c = t.clips[i]; if (c) studio.launch(t, c); else studio.stopTrack(t); }
}

// ---- small controls in Ableton's manner: a toggle that fills when on, a value box you drag
function toggle(W, label, get, flip, cls, help) {
  const el = h("button", { class: `pc-tog ${cls}`, "data-help": help, onpointerdown: (e) => { if (e.button === 0) flip(); } }, label);
  let shown = null;
  W.add(el, () => { const v = get(); if (v !== shown) { shown = v; el.classList.toggle("on", v); } });
  return el;
}

const dbOf = (v) => (v <= 0.001 ? "-inf" : (20 * Math.log10(gainOf(v))).toFixed(1));
function volBox(W, get, set) {
  const el = h("div", { class: "pc-val", "data-help": "<b>Volume</b>  Drag up or down, Shift for fine. Double-click resets" });
  let shown = null;
  W.add(el, () => { const v = get(); if (v !== shown) { shown = v; el.textContent = dbOf(v); } });
  dragBy(el, (dy, ev) => set(Math.min(1, Math.max(0, get() - dy * (ev.shiftKey ? 0.001 : 0.005)))), { reset: () => set(UNITY) });
  return el;
}
