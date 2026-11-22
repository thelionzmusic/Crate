// Production mode: the transport across the top, the browser down the left, Clip or Timeline
// view in the middle (Tab switches), and the selected strip's device chain along the bottom.
import { $, h, mount } from "../core/dom.js";
import { safe, toast } from "../core/api.js";
import { confirmSheet, splitter } from "../core/ui.js";
import { pref, setPref } from "../core/prefs.js";
import { Widgets, clockText, pbtn, text } from "../perform/controls.js";
import { studio } from "./engine.js";
import { P, addReturn, addTrack, duplicateDevice, edit, loadSet, nameOf, newSet, onRedraw, owner, removeDevice, step, stripOfDevice, trackById } from "./set.js";
import { initBrowser } from "./browser.js";
import { groupPicked, renderClips, ungroupSelected } from "./clips.js";
import { drawTimeline, marker, renderTimeline } from "./timeline.js";
import { chainDrop, renderChain } from "./chain.js";

const W = new Widgets(), V = new Widgets(), D = new Widgets();  // W: built once; V: the view and D: the devices, rebuilt per edit
let root = null, raf = 0;

export async function enter() {
  if (!root) await build();
  start();
}
export function leave() { cancelAnimationFrame(raf); raf = 0; }  // sound carries on: clips keep playing under Perform

async function build() {
  root = $("#produce");
  try { await studio.start(); } catch (e) { toast(`Audio couldn't start: ${e.message}`, 7000); }
  studio.on((kind, msg) => { if (kind === "error") toast(msg, 6000); });
  await loadSet();
  P.view = pref("produceView", "clips");
  mount(root, transport(), h("aside", { class: "pbrowser" }), h("section", { class: "pview" }), devices());
  initBrowser($(".pbrowser", root));
  splitter($(".pd-split", root), { cssVar: "--pdev", store: "produceDevicesH", target: () => $(".pdevices", root), min: 120, reserve: 240, onResize: () => {} });
  root.addEventListener("pointerdown", (e) => { if (!e.target.closest(".dev")) P.dev = null; }, true);  // a click elsewhere drops the device selection
  onRedraw(renderView); onRedraw(renderDevices);
  renderView(); renderDevices();
}

function renderView() {
  const el = $(".pview", root);
  V.clear(); el.className = `pview ${P.view}`;
  (P.view === "clips" ? renderClips : renderTimeline)(el, V);
}

export function setView(v) { if (v === P.view) return; P.view = v; setPref("produceView", v); renderView(); }

function start() {
  if (raf) return;
  const frame = () => { W.sync(); V.sync(); D.sync(); if (P.view === "timeline") drawTimeline(); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
}

// ---- transport: follow, tempo, quantise, position, play/stop, views, new set
function transport() {
  const s = () => P.set;
  const bpmBox = h("input", { class: "pt-bpm", inputmode: "decimal", "aria-label": "Tempo", "data-help": "<b>Tempo</b>  Type a BPM. With Follow on, a playing deck sets it",
    onchange: (e) => { const v = parseFloat(e.target.value); if (v >= 20 && v <= 999) edit(() => { s().bpm = v; studio.setTempo(v); }); e.target.blur(); } });
  let shownBpm = null;
  W.add(bpmBox, () => { const v = studio.tempo().toFixed(2); if (v !== shownBpm && document.activeElement !== bpmBox) { shownBpm = v; bpmBox.value = v; } });
  const quant = h("select", { class: "pt-quant", "aria-label": "Launch quantise", "data-help": "<b>Launch quantise</b>  Where launched clips start",
    onchange: (e) => { studio.quantise = +e.target.value; } },
  ...[["None", 0], ["1 Beat", 1], ["1 Bar", 4], ["2 Bars", 8], ["4 Bars", 16]].map(([l, v]) => h("option", { value: v, selected: v === studio.quantise }, l)));
  const viewBtn = (v, label, key) => pbtn(W, label, () => setView(v), { on: () => P.view === v, help: `<b>${label} view</b>  Tab switches  ${key}` });
  return h("header", { class: "ptrans" },
    pbtn(W, "Follow", () => edit(() => { s().follow = !s().follow; }), { on: () => s().follow, cls: "follow", help: "<b>Follow</b>  Lock tempo and bars to the playing deck in Perform" }),
    h("div", { class: "pt-box" }, bpmBox, text(W, () => (studio.leader ? "DECK" : "SET"), "pt-src")),
    h("span", { class: "pt-sig" }, "4 / 4"),
    quant,
    h("div", { class: "spacer" }),
    clockText(W, position, "pt-pos"),
    pbtn(W, "▶", togglePlay, { cls: "go", on: () => !!studio.song, help: "<b>Play</b>  The timeline, from the marker  Space" }),
    pbtn(W, "■", stopEverything, { help: "<b>Stop</b>  Everything, now" }),
    h("div", { class: "spacer" }),
    h("div", { class: "pt-views" }, viewBtn("clips", "Clips", "F7"), viewBtn("timeline", "Timeline", "F7")),
    pbtn(W, "+ Audio", () => edit(() => addTrack("audio")), { help: "<b>New audio track</b>  Ctrl+T" }),
    pbtn(W, "+ MIDI", () => edit(() => addTrack("midi")), { help: "<b>New MIDI track</b>  Ctrl+Shift+T" }),
    pbtn(W, "+ Return", () => edit(addReturn), { help: "<b>New return track</b>  For sends to a shared reverb or delay  Ctrl+Alt+T" }),
    pbtn(W, "New set", startNew));
}

// bars.beats.sixteenths, of the timeline while it plays, otherwise of the transport
function position() {
  const b = studio.out ? studio.songBeat() ?? studio.beatNow() : 0, bar = Math.floor(b / 4) + 1, beat = Math.floor(b % 4) + 1, six = Math.floor((b % 1) * 4) + 1;
  return `${bar}.${beat}.${six}`;
}

function togglePlay() { if (studio.song) studio.stopSong(); else studio.playSong(marker()); }
function stopEverything() { studio.stopSong(); studio.stopAll(true); studio.stopPreview(); }
const startNew = safe(async () => { if (await confirmSheet("Start a new set?", "This clears the tracks and clips. Undo can't bring them back.", "New set", true)) await newSet(); });

// Delete and duplicate act on what's selected: a device, else a timeline clip or a clip slot
function removeSelected() {
  const [o, d] = selectedDevice();
  if (d) return edit(() => removeDevice(o, d)), true;
  if (P.view === "timeline" && P.item) { const a = P.item; edit(() => { P.set.arrangement = P.set.arrangement.filter((x) => x !== a); P.item = null; }); return true; }
  if (P.view === "clips" && P.clip) { const [id, i] = P.clip, t = trackById(id); if (t?.clips[i]) { edit(() => { delete t.clips[i]; }); return true; } }
  return false;
}
function duplicateSelected() {
  const [o, d] = selectedDevice();
  if (d) return edit(() => duplicateDevice(o, d)), true;
  if (P.view === "timeline" && P.item) { const a = P.item; edit(() => { const b = { ...structuredClone(a), start: a.start + a.length }; P.set.arrangement.push(b); P.item = b; }); return true; }
  return false;
}

// what the menu bar can do here; the keys below do the same things
export const commands = {
  newSet: startNew, undo: () => step(true), redo: () => step(false), remove: removeSelected, duplicate: duplicateSelected,
  audioTrack: () => edit(() => addTrack("audio")), midiTrack: () => edit(() => addTrack("midi")), returnTrack: () => edit(addReturn),
  group: groupPicked, ungroup: ungroupSelected, scene: () => edit(() => { P.set.scenes++; }),
  play: togglePlay, stop: stopEverything, follow: () => edit(() => { P.set.follow = !P.set.follow; }), following: () => !!P.set?.follow,
  view: setView, viewing: () => P.view, find: () => $(".pb-search input", root)?.focus(),
};

// ---- the selected strip's device chain, rebuilt when the selection or the set changes
function devices() {
  const strip = () => owner(P.sel);
  const chain = h("div", { class: "pd-chain" });
  chainDrop(chain);
  const el = h("footer", { class: "pdevices" },
    h("div", { class: "pd-split", "data-help": "<b>Devices</b>  Drag to resize. Double-click resets" }),
    h("div", { class: "pd-title" }, text(W, () => { const o = strip(); return o ? nameOf(o) : "Nothing selected"; }, "pd-name")),
    chain);
  let colour = null, sel;
  W.add(el, () => {
    const o = strip(), c = o?.colour || "#b4b4ba";  // Main has no colour of its own: a light grey
    if (c !== colour) { colour = c; el.style.setProperty("--c", c); }
    if (P.sel !== sel) { sel = P.sel; renderDevices(); }
  });
  return el;
}
function renderDevices() {
  D.clear(); renderChain($(".pd-chain", root), D);
  root.classList.toggle("bare", !owner(P.sel)?.devices.length);  // nothing on it: the chain folds to a bar
}

const selectedDevice = () => { const o = P.dev != null && stripOfDevice(P.dev); return o ? [o, o.devices.find((d) => d.id === P.dev)] : []; };

// ---- keys; returns true when used
export function key(e) {
  const k = e.key;
  if (k === "Tab") { setView(P.view === "clips" ? "timeline" : "clips"); return true; }
  if (k === " ") { if (studio.busy) stopEverything(); else togglePlay(); return true; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { step(!e.shiftKey); return true; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "y") { step(false); return true; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "g") { if (e.shiftKey) ungroupSelected(); else groupPicked(); return true; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "t") { (e.altKey ? commands.returnTrack : e.shiftKey ? commands.midiTrack : commands.audioTrack)(); return true; }
  if (k === "Delete" || k === "Backspace") return removeSelected();
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "d") return duplicateSelected();
  if (k === "Escape") { P.item = P.clip = P.dev = null; studio.stopPreview(); renderView(); return true; }
  return false;
}
