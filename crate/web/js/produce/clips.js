// Clip view: one column per track (title bar, clip slots, mixer at the foot), then Main with
// the scene launchers. Built once per edit; what plays and what's queued is synced per frame.
import { h, icon, mount } from "../core/dom.js";
import { askSheet, menu } from "../core/ui.js";
import { safe } from "../core/api.js";
import { drag as dragBy, knob, vu } from "../perform/controls.js";
import { UNITY, gainOf, studio } from "./engine.js";
import { P, addTrack, drag, edit, makeClip, mixAll, removeTrack, save, soloed } from "./set.js";

export function renderClips(el, W) {
  const s = P.set;
  mount(el,
    ...s.tracks.map((t) => column(t, W)),
    h("div", { class: "pc-drop", ...dropTo((clip) => { const t = addTrack("audio", clip.name); t.clips[0] = clip; }) }, h("span", {}, "Drop files and devices here")),
    mainColumn(W));
}

function column(t, W) {
  const slots = [];
  for (let i = 0; i < P.set.scenes; i++) slots.push(slot(t, i, W));
  return selectable(W, t, h("div", { class: "pc-track", style: `--c:${t.colour}` },
    trackHead(t),
    h("div", { class: "pc-slots" }, ...slots,
      h("button", { class: "pc-stop", "data-help": "<b>Stop</b>  Stops this track's clip at the next bar", onclick: () => studio.stopTrack(t) }, icon("i-stop", "i sm"))),
    h("div", { class: "pc-fill" }),
    mixFoot(t, W)));
}

// the selected track (whose devices show below) is marked per frame, so selecting never rebuilds
export function selectable(W, t, el) {
  let shown = null;
  return W.add(el, () => { const v = P.sel === t.id; if (v !== shown) { shown = v; el.classList.toggle("sel", v); } });
}

export function trackHead(t) {
  return h("div", { class: "pc-head", "data-help": `<b>${t.name}</b>  Click to select, double-click to rename, right-click for more`,
    onpointerdown: () => { P.sel = t.id; },
    ondblclick: () => rename(t),
    oncontextmenu: (e) => { e.preventDefault(); menu(e, [{ label: "Rename", run: () => rename(t) }, "-", { label: "Delete track", danger: true, run: () => edit(() => removeTrack(t)) }]); } },
  h("span", {}, t.name));
}
const rename = safe(async (t) => { const v = await askSheet("Rename track", t.name); if (v) edit(() => { t.name = v; }); });

function slot(t, i, W) {
  const clip = t.clips[i];
  const el = h("div", { class: "pc-slot" + (clip ? " full" : ""), ...dropTo((c) => { t.clips[i] = c; P.clip = [t.id, i]; }) });
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

// a drop target that turns whatever's dragged into a clip, then hands it to `put` as one edit
function dropTo(put) {
  return {
    ondragover: (e) => { if (drag.item) { e.preventDefault(); e.currentTarget.classList.add("drop"); } },
    ondragleave: (e) => e.currentTarget.classList.remove("drop"),
    ondrop: safe(async (e) => {
      e.preventDefault(); e.currentTarget.classList.remove("drop");
      const item = drag.item; if (!item) return;
      const clip = await makeClip(item);
      edit(() => put(clip));
    }),
  };
}

// ---- the mixer: activator (track number), solo, volume in dB, pan, meter
function mixFoot(t, W) {
  return h("div", { class: "pc-mix" },
    h("div", { class: "pc-mixrow" }, ...trackToggles(W, t)),
    h("div", { class: "pc-mixrow" },
      trackVol(W, t),
      knob(W, "Pan", () => (t.pan + 1) / 2, (v) => { t.pan = Math.round((Math.min(1, Math.max(0, v)) * 2 - 1) * 50) / 50; studio.mix(t, soloed()); save(); }, { size: 26, help: "Drag up or down. Double-click to centre" })),
    vu(W, () => studio.track(t).meter()));
}

// shared with the timeline's track headers
export const trackToggles = (W, t) => [
  toggle(W, String(t.id), () => !t.mute, () => { t.mute = !t.mute; mixAll(); save(); }, "act", "<b>Track on</b>  Click to mute"),
  toggle(W, "S", () => t.solo, () => { t.solo = !t.solo; mixAll(); save(); }, "solo", "<b>Solo</b>")];
export const trackVol = (W, t) => volBox(W, () => t.volume, (v) => { t.volume = v; studio.mix(t, soloed()); save(); });

function mainColumn(W) {
  const s = P.set, scenes = [];
  for (let i = 0; i < s.scenes; i++) {
    scenes.push(h("button", { class: "pc-scene", "data-help": "<b>Scene</b>  Launches this row across every track", onclick: () => launchScene(i) },
      icon("i-play", "i xs fill"), h("span", {}, String(i + 1))));
  }
  return h("div", { class: "pc-track pc-main" },
    h("div", { class: "pc-head" }, h("span", {}, "Main")),
    h("div", { class: "pc-slots" }, ...scenes,
      h("button", { class: "pc-stop", "data-help": "<b>Stop all clips</b>", onclick: () => studio.stopAll() }, icon("i-stop", "i sm"), h("span", {}, "Stop all"))),
    h("div", { class: "pc-fill" }),
    h("div", { class: "pc-mix" },
      h("div", { class: "pc-mixrow" }, h("button", { class: "pbtn", onclick: () => edit(() => { s.scenes++; }) }, "+ Scene")),
      h("div", { class: "pc-mixrow" }, volBox(W, () => s.main.volume, (v) => { s.main.volume = v; studio.setMain(v); save(); })),
      vu(W, () => studio.mainMeter())));
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
