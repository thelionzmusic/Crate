// Clip view: one column per track (title bar, clip slots, mixer at the foot), groups folding
// their members away, the return tracks, then Main with the scene launchers. Built once per edit; what plays, what's queued
// and which strip is selected are synced per frame.
import { h, icon, mount, svg } from "../core/dom.js";
import { askSheet, menu } from "../core/ui.js";
import { safe } from "../core/api.js";
import { studio } from "./engine.js";
import { DEVICES } from "./fx/devices.js";
import { MAIN_COLOUR, P, addDevice, addReturn, addTrack, drag, edit, groupTracks, isGroup, isMidi, keyOf, makeClip, membersOf, nameOf, newMidiClip, openClip, parentOf, redraw, remix,
  removeReturn, removeTrack, save, touch, ungroup, visibleTracks } from "./set.js";
import { audioTo, fader, panKnob, sendKnob, stripVol, toggle, trackToggles } from "./mixer.js";

// how far the scenes are scrolled when there isn't room for them all; every column's slots follow it
let sceneTop = 0;
const scrollScenes = (el, top) => {
  const all = el.querySelectorAll(".pc-slots"), max = Math.max(0, ...[...all].map((x) => x.scrollHeight - x.clientHeight));
  sceneTop = Math.max(0, Math.min(max, top));
  for (const x of all) x.scrollTop = sceneTop;
};

export function renderClips(el, W) {
  const s = P.set;
  el.onwheel = (e) => { if (e.target.closest(".pc-slots") && !e.ctrlKey) { e.preventDefault(); scrollScenes(el, sceneTop + e.deltaY); } };
  requestAnimationFrame(() => scrollScenes(el, sceneTop));  // rebuilt: back where it was
  mount(el,
    ...visibleTracks().map((t) => (isGroup(t) ? groupColumn(t, W) : column(t, W))),
    h("div", { class: "pc-drop", ...dropTo((item) => addTrack(DEVICES[item.type]?.instrument ? "midi" : "audio"), (clip) => { const t = addTrack("audio", clip.name); t.clips[0] = clip; }) },
      glow(), h("span", {}, "Drop files and devices here")),
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

// A clip slot. The ▶ launches its clip and the body selects it, as in Ableton; double-clicking a
// MIDI clip opens its notes, and double-clicking an empty slot on a MIDI track makes one.
function slot(t, i, W) {
  const clip = t.clips[i], midi = t.kind === "midi";
  const el = h("div", { class: "pc-slot" + (clip ? " full" : "") + (isMidi(clip) ? " midi" : ""), ...dropTo(() => t, (c) => { t.clips[i] = c; P.clip = [t.id, i]; }) });
  if (!clip) {
    el.append(icon("i-stop", "i xs"));
    el.addEventListener("click", () => { studio.stopTrack(t); P.clip = [t.id, i]; });
    if (midi) {
      el.dataset.help = "<b>Empty slot</b>  Double-click to make a MIDI clip";
      el.addEventListener("dblclick", () => edit(() => { t.clips[i] = newMidiClip(); P.clip = [t.id, i]; openClip({ track: t.id, slot: i }); }));
    }
    return el;
  }
  el.draggable = true;
  const go = h("button", { class: "pc-go", "aria-label": "Launch", "data-help": "<b>Launch</b>  Starts this clip at the next bar",
    onclick: (e) => { e.stopPropagation(); studio.launch(t, clip); P.clip = [t.id, i]; } }, icon("i-play", "i xs fill"));
  el.append(go, h("span", {}, clip.name), h("b", { class: "pc-prog" }));
  el.dataset.help = isMidi(clip) ? "<b>MIDI clip</b>  ▶ launches it. Double-click to edit its notes" : "<b>Clip</b>  ▶ launches it";
  el.addEventListener("click", () => { P.clip = [t.id, i]; });
  if (isMidi(clip)) el.addEventListener("dblclick", () => { openClip({ track: t.id, slot: i }); redraw(); });
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

// A drop target. A device from the browser goes onto strip(item); anything else becomes a clip
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
      if (item.kind === "device") return edit(() => { const o = strip(item); addDevice(o, item.type, undefined, item.preset); P.sel = keyOf(o); });
      const clip = await makeClip(item);
      edit(() => put(clip));
    }),
  };
}

// ---- a column's foot: where it plays, its sends, activator, solo and pan, then the fader and its value
function mixFoot(t, W) {
  return h("div", { class: "pc-mix" },
    h("div", { class: "pc-lab" }, "Audio To"), audioTo(W, t),
    P.set.returns.length ? h("div", { class: "pc-mixrow pc-sends" }, ...P.set.returns.map((r) => sendKnob(W, t, r))) : null,
    h("div", { class: "pc-mixrow" }, ...trackToggles(W, t), panKnob(W, t)),
    fader(W, t, () => t.colour), stripVol(W, t));
}

function returnColumn(r, W) {
  return selectable(W, r.id, h("div", { class: "pc-track pc-return", style: `--c:${r.colour}`, ...dropTo(() => r) },
    stripHead(r),
    h("div", { class: "pc-fill" }),
    h("div", { class: "pc-mix" },
      h("div", { class: "pc-mixrow" }, toggle(W, r.id, () => !r.mute, () => { touch(); r.mute = !r.mute; remix(r); save(); }, "act", "<b>Return on</b>  Click to mute"), panKnob(W, r)),
      fader(W, r, () => r.colour), stripVol(W, r))));
}

function mainColumn(W) {
  const s = P.set, scenes = [];
  for (let i = 0; i < s.scenes; i++) {
    scenes.push(h("button", { class: "pc-scene", "data-help": "<b>Scene</b>  Launches this row across every track", onclick: () => launchScene(i) },
      icon("i-play", "i xs fill"), h("span", {}, String(i + 1))));
  }
  return selectable(W, "main", h("div", { class: "pc-track pc-main", style: `--c:${MAIN_COLOUR}`, ...dropTo(() => s.main) },
    stripHead(s.main),
    h("div", { class: "pc-slots" }, ...scenes,
      h("button", { class: "pc-stop", "data-help": "<b>Stop all clips</b>", onclick: () => studio.stopAll() }, icon("i-stop", "i sm"), h("span", {}, "Stop all"))),
    h("div", { class: "pc-fill" }),
    h("div", { class: "pc-mix" },
      h("div", { class: "pc-mixrow" }, h("button", { class: "pbtn", onclick: () => edit(() => { s.scenes++; }) }, "+ Scene")),
      fader(W, s.main, () => MAIN_COLOUR), stripVol(W, s.main))));
}

function launchScene(i) {
  for (const t of P.set.tracks) { const c = t.clips[i]; if (c) studio.launch(t, c); else studio.stopTrack(t); }
}

// The empty stretch beside the tracks: light through the set's colours, drawn once
function glow() {
  const s = svg("svg", { class: "pc-glow", viewBox: "0 0 600 240", preserveAspectRatio: "xMidYMid meet", "aria-hidden": "true" });
  s.innerHTML = `<defs><linearGradient id="pcg" x1="0" x2="1"><stop offset="0" stop-color="#4f8cff" stop-opacity="0"/><stop offset=".35" stop-color="#9d7bff"/>
    <stop offset=".7" stop-color="#c58bff"/><stop offset="1" stop-color="#4f8cff" stop-opacity="0"/></linearGradient>
    <filter id="pcb" x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="6"/></filter></defs>` +
    [[0, 1, 46], [0.9, 0.7, 34], [2.1, 0.5, 58], [3.3, 0.35, 24]].map(([ph, op, amp]) => {
      let d = "";
      for (let x = 0; x <= 600; x += 6) { const u = x / 600, y = 120 + Math.sin(u * Math.PI * 3 + ph) * amp * Math.sin(u * Math.PI); d += `${x ? "L" : "M"}${x},${y.toFixed(1)}`; }
      return `<path d="${d}" stroke="url(#pcg)" stroke-width="5" fill="none" opacity="${op * 0.5}" filter="url(#pcb)"/><path d="${d}" stroke="url(#pcg)" stroke-width="1.2" fill="none" opacity="${op}"/>`;
    }).join("");
  return s;
}
