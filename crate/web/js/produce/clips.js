// Clip view: one column per track (title bar, clip slots, mixer at the foot), groups folding
// their members away, the return tracks, then Main with the scene launchers. Built once per edit; what plays, what's queued
// and which strip is selected are synced per frame.
import { h, icon, mount } from "../core/dom.js";
import { askSheet, menu } from "../core/ui.js";
import { safe } from "../core/api.js";
import { drag as dragBy, knob, vu } from "../perform/controls.js";
import { UNITY, gainOf, studio } from "./engine.js";
import { P, addDevice, addReturn, addTrack, drag, edit, groupTracks, isGroup, keyOf, makeClip, membersOf, mixAll, nameOf, parentOf, remix, removeReturn, removeTrack,
  save, touch, ungroup, visibleTracks } from "./set.js";

export function renderClips(el, W) {
  const s = P.set;
  mount(el,
    ...visibleTracks().map((t) => (isGroup(t) ? groupColumn(t, W) : column(t, W))),
    h("div", { class: "pc-drop", style: `--scenes:${s.scenes}`, ...dropTo(() => addTrack("audio"), (clip) => { const t = addTrack("audio", clip.name); t.clips[0] = clip; }) },
      h("span", {}, "Drop files and effects here")),
    ...s.returns.map((r) => returnColumn(r, W)),
    mainColumn(W));
}

// a track inside a group carries the group's colour along its top edge
const colours = (t) => `--c:${t.colour};${parentOf(t) ? `--gc:${parentOf(t).colour}` : ""}`;

function column(t, W) {
  const slots = [];
  for (let i = 0; i < P.set.scenes; i++) slots.push(slot(t, i, W));
  return selectable(W, t.id, h("div", { class: "pc-track" + (t.group ? " member" : ""), style: colours(t), ...dropTo(() => t) },
    stripHead(t),
    h("div", { class: "pc-slots" }, ...slots,
      h("button", { class: "pc-stop", "data-help": "<b>Stop</b>  Stops this track's clip at the next bar", onclick: () => studio.stopTrack(t) }, icon("i-stop", "i sm"))),
    h("div", { class: "pc-fill" }),
    mixFoot(t, W)));
}

// A group: its slots launch its members' clips in that row, its mixer is the members' bus.
// Folded, its members' columns are hidden.
function groupColumn(g, W) {
  const members = membersOf(g).filter((t) => !isGroup(t)), slots = [];
  for (let i = 0; i < P.set.scenes; i++) {
    const here = members.filter((t) => t.clips[i]);
    const el = h("div", { class: "pc-slot" + (here.length ? " full group" : ""), "data-help": here.length ? "<b>Group slot</b>  Launches its tracks' clips in this row" : "" },
      icon(here.length ? "i-play" : "i-stop", "i xs" + (here.length ? " fill" : "")), here.length ? h("span", {}, `${here.length} clip${here.length > 1 ? "s" : ""}`) : null);
    el.addEventListener("click", () => { for (const t of members) { if (t.clips[i]) studio.launch(t, t.clips[i]); else studio.stopTrack(t); } });
    let shown = null;
    if (here.length) W.add(el, () => { const on = here.some((t) => studio.state(t).playing === t.clips[i]); if (on !== shown) { shown = on; el.classList.toggle("playing", on); } });
    slots.push(el);
  }
  return selectable(W, g.id, h("div", { class: "pc-track pc-group" + (g.group ? " member" : ""), style: colours(g), ...dropTo(() => g) },
    stripHead(g),
    h("div", { class: "pc-slots" }, ...slots,
      h("button", { class: "pc-stop", "data-help": "<b>Stop</b>  Stops every clip in this group at the next bar", onclick: () => members.forEach((t) => studio.stopTrack(t)) }, icon("i-stop", "i sm"))),
    h("div", { class: "pc-fill" }),
    mixFoot(g, W)));
}

// the strip whose devices show below, and tracks picked together, are marked per frame
export function selectable(W, key, el) {
  let shown = "";
  return W.add(el, () => {
    const sel = P.sel === key, picked = P.picked.size > 1 && P.picked.has(key), s = `${sel}${picked}`;
    if (s !== shown) { shown = s; el.classList.toggle("sel", sel); el.classList.toggle("picked", picked); }
  });
}

// Clicking a track's title picks it; Ctrl adds or removes one, Shift takes the run between.
function pick(o, e) {
  const key = keyOf(o);
  if (o.kind && (e.ctrlKey || e.metaKey)) { if (P.picked.has(key) && P.picked.size > 1) P.picked.delete(key); else P.picked.add(key); }
  else if (o.kind && e.shiftKey && typeof P.sel === "number") {
    const ids = visibleTracks().map((t) => t.id), a = ids.indexOf(P.sel), b = ids.indexOf(key);
    if (a >= 0 && b >= 0) P.picked = new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1));
  } else P.picked = new Set(o.kind ? [key] : []);
  P.sel = key;
}

// a strip's title bar: click selects it, double-click renames, right-click for more (`items`, or a
// function giving them when the menu opens); a group's has its fold
function head(o, items) {
  const fold = isGroup(o) ? h("button", { class: "pc-fold" + (o.fold ? "" : " open"), "aria-label": o.fold ? "Unfold group" : "Fold group",
    "data-help": "<b>Fold</b>  Show or hide the tracks in this group", onpointerdown: (e) => e.stopPropagation(), onclick: () => edit(() => { o.fold = !o.fold; }) }, icon("i-chev", "i xs")) : null;
  return h("div", { class: "pc-head", "data-help": `<b>${nameOf(o)}</b>  Click to show its devices${items ? ". Ctrl or Shift-click to pick several, then Ctrl+G groups them. Double-click to rename, right-click for more" : ""}`,
    onpointerdown: (e) => { if (e.button === 0) pick(o, e); },
    ondblclick: items ? () => rename(o) : null,
    oncontextmenu: items ? (e) => { e.preventDefault(); if (!P.picked.has(keyOf(o))) pick(o, {}); menu(e, typeof items === "function" ? items() : items); } : null },
  fold, h("span", {}, nameOf(o)));
}
// what Ctrl+G and Ctrl+Shift+G do, from here and from the keyboard
export const groupPicked = () => { const ids = P.picked.size ? P.picked : new Set([P.sel]); if ([...ids].every((k) => typeof k === "number")) edit(() => groupTracks(ids)); };
export const ungroupSelected = () => { const g = P.set.tracks.find((t) => t.id === P.sel && isGroup(t)); if (g) edit(() => ungroup(g)); };
const rename = safe(async (o) => { const v = await askSheet("Rename", o.name); if (v) edit(() => { o.name = v; }); });
const newReturn = { label: "Insert return track", kbd: "Ctrl+Alt+T", run: () => edit(addReturn) };
// the title bar of any strip, with what can be done to it; shared with the timeline's headers
export function stripHead(o) {
  if (o === P.set.main) return head(o, null);
  if (!o.kind) return head(o, [{ label: "Rename", run: () => rename(o) }, newReturn, "-", { label: "Delete return track", danger: true, run: () => edit(() => removeReturn(o)) }]);
  return head(o, () => [{ label: "Rename", run: () => rename(o) },
    { label: P.picked.size > 1 ? `Group ${P.picked.size} tracks` : "Group track", kbd: "Ctrl+G", run: groupPicked },
    isGroup(o) ? { label: "Ungroup", kbd: "Ctrl+Shift+G", run: ungroupSelected } : null,
    newReturn, "-",
    { label: isGroup(o) ? "Delete group and its tracks" : "Delete track", danger: true, run: () => edit(() => removeTrack(o)) }]);
}

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
    stripHead(r),
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
    stripHead(s.main),
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

const dbText = (v) => (v <= 0.001 ? "-inf" : (20 * Math.log10(gainOf(v))).toFixed(1));
function volBox(W, get, set) {
  const el = h("div", { class: "pc-val", "data-help": "<b>Volume</b>  Drag up or down, Shift for fine. Double-click resets" });
  let shown = null;
  W.add(el, () => { const v = get(); if (v !== shown) { shown = v; el.textContent = dbText(v); } });
  dragBy(el, (dy, ev) => set(Math.min(1, Math.max(0, get() - dy * (ev.shiftKey ? 0.001 : 0.005)))), { reset: () => set(UNITY) });
  return el;
}
