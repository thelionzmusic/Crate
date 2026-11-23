// Production mode: the transport across the top, the browser down the left, Clip or Timeline
// view in the middle (Tab switches), and along the bottom the selected strip's device chain or
// the open MIDI clip's piano roll (Shift+Tab switches).
import { $, h, mount } from "../core/dom.js";
import { safe, toast } from "../core/api.js";
import { confirmSheet, menu, splitter } from "../core/ui.js";
import { refreshEditors, syncEditors } from "./instruments/editor.js";
import { pref, setPref } from "../core/prefs.js";
import { Widgets, clockText, pbtn, text } from "../perform/controls.js";
import { studio } from "./engine.js";
import { MAIN_COLOUR, NOTE_NAMES, P, addReturn, addTrack, clipAt, duplicateDevice, edit, keyName, loadSet, nameOf, newSet, onRedraw, owner, redraw, removeDevice, save, step, stripOfDevice, touch, trackById } from "./set.js";
import { initBrowser } from "./browser.js";
import { groupPicked, renderClips, ungroupSelected } from "./clips.js";
import { drawTimeline, marker, renderTimeline } from "./timeline.js";
import { chainDrop, renderChain } from "./chain.js";
import { renderRoll, rollKey } from "./pianoroll.js";

const W = new Widgets(), V = new Widgets(), D = new Widgets();  // W: built once; V: the view and D: the devices or clip, rebuilt per edit
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
  // the selected strip, at the right of the status bar as in Ableton
  const chip = text(W, () => { const o = owner(P.sel); return o ? nameOf(o) : ""; }, "st-strip");
  $(".status").append(W.add(chip, () => { const c = owner(P.sel)?.colour || MAIN_COLOUR; if (chip.dataset.c !== c) { chip.dataset.c = c; chip.style.setProperty("--c", c); } }));
  splitter($(".pd-split", root), { cssVar: "--pdev", store: "produceDevicesH", target: () => $(".pdevices", root), min: 120, reserve: 240, onResize: () => {} });
  root.addEventListener("pointerdown", (e) => { if (!e.target.closest(".dev")) P.dev = null; }, true);  // a click elsewhere drops the device selection
  onRedraw(renderView); onRedraw(renderDevices); onRedraw(refreshEditors);
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
  const frame = () => { W.sync(); V.sync(); D.sync(); syncEditors(); if (P.view === "timeline") drawTimeline(); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
}

// ---- transport: tap and tempo, metre, launch quantise, follow; stop, play and the position;
// the set's key, the sound card's rate and load, and the views. Adding tracks and starting a
// set live in the menu bar.
function transport() {
  const s = () => P.set;
  const bpmBox = h("input", { class: "pt-bpm", inputmode: "decimal", "aria-label": "Tempo", "data-help": "<b>Tempo</b>  Type a BPM. With Follow on, a playing deck sets it",
    onchange: (e) => { const v = parseFloat(e.target.value); if (v >= 20 && v <= 999) edit(() => { s().bpm = v; studio.setTempo(v); }); e.target.blur(); } });
  let shownBpm = null;
  W.add(bpmBox, () => { const v = studio.tempo().toFixed(2); if (v !== shownBpm && document.activeElement !== bpmBox) { shownBpm = v; bpmBox.value = v; } });
  const quant = h("select", { class: "pt-quant", "aria-label": "Launch quantise", "data-help": "<b>Launch quantise</b>  Where launched clips start",
    onchange: (e) => { studio.quantise = +e.target.value; } },
  ...[["None", 0], ["1 Beat", 1], ["1 Bar", 4], ["2 Bars", 8], ["4 Bars", 16]].map(([l, v]) => h("option", { value: v, selected: v === studio.quantise }, l)));
  const viewBtn = (v, label) => pbtn(W, label, () => setView(v), { on: () => P.view === v, help: `<b>${label} view</b>  Tab switches` });
  return h("header", { class: "ptrans" },
    pbtn(W, "Tap", tap, { cls: "pt-tap", help: "<b>Tap tempo</b>  Tap four times or more in time" }),
    h("div", { class: "pt-box" }, bpmBox, text(W, () => (studio.leader ? "DECK" : "BPM"), "pt-src")),
    h("span", { class: "pt-sig" }, "4 / 4"),
    quant,
    pbtn(W, "Follow", () => edit(() => { s().follow = !s().follow; }), { on: () => s().follow, cls: "follow", help: "<b>Follow</b>  Lock tempo and bars to the playing deck in Perform" }),
    h("div", { class: "spacer" }),
    pbtn(W, "■", stopEverything, { cls: "pt-stop", help: "<b>Stop</b>  Everything, now" }),
    pbtn(W, "▶", togglePlay, { cls: "go", on: () => !!studio.song, help: "<b>Play</b>  The timeline, from the marker  Space" }),
    clockText(W, position, "pt-pos"),
    h("div", { class: "spacer" }),
    h("button", { class: "pt-key", "data-help": "<b>Key</b>  The set's key. The piano roll shades the notes outside it", onclick: keyMenu },
      h("small", {}, "Key"), text(W, () => keyName(s().key))),
    h("div", { class: "pt-audio", "data-help": "<b>Audio</b>  The sound card's sample rate, and how much of the audio thread Production's sound uses" },
      text(W, () => (studio.out ? `${+(studio.out.rate / 1000).toFixed(1)} kHz` : "")),
      text(W, () => (studio.out?.load == null ? "" : `CPU ${Math.round(studio.out.load * 100)}%`), "pt-cpu")),
    h("div", { class: "pt-views" }, viewBtn("clips", "Clips"), viewBtn("timeline", "Timeline")));
}

// Tap tempo: the average of the last few gaps, once there are three; a pause of two seconds starts over
const taps = [];
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now); if (taps.length > 5) taps.shift();
  if (taps.length < 4) return;
  const bpm = Math.round(60000 * (taps.length - 1) / (now - taps[0]) * 100) / 100;
  if (bpm < 20 || bpm > 999) return;
  touch(); P.set.bpm = bpm; studio.setTempo(bpm); save();
}

// the set's key: none, or a root in major or minor
function keyMenu(e) {
  const k = P.set.key, set = (key) => edit(() => { if (key) P.set.key = key; else delete P.set.key; });
  const roots = (scale) => NOTE_NAMES.map((n, root) => ({ label: n, checked: k?.root === root && k.scale === scale, run: () => set({ root, scale }) }));
  menu(e, [{ label: "No key", checked: !k, run: () => set(null) }, "-", { label: "Major", sub: roots("major") }, { label: "Minor", sub: roots("minor") }]);
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
  if (P.view === "timeline" && P.item) {
    const a = P.item, i = P.set.arrangement.indexOf(a), open = P.open?.item;
    edit(() => { P.set.arrangement.splice(i, 1); P.item = null; if (open === i) P.open = null; else if (open > i) P.open = { item: open - 1 }; });
    return true;
  }
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

// ---- the selected strip's device chain, or the open clip; rebuilt when the selection or the set changes
function devices() {
  const strip = () => owner(P.sel);
  const chain = h("div", { class: "pd-chain" });
  chainDrop(chain);
  const el = h("footer", { class: "pdevices" },
    h("div", { class: "pd-split", "data-help": "<b>Devices</b>  Drag to resize. Double-click resets" }),
    h("div", { class: "pd-title", "data-help": "<b>Devices or clip</b>  Click to switch, once a MIDI clip is open  Shift+Tab", onclick: flipDetail },
      text(W, () => { const o = strip(); return P.detail === "clip" ? clipAt(P.open)?.clip.name : o ? nameOf(o) : "Nothing selected"; }, "pd-name")),
    chain, h("div", { class: "pd-clip" }));
  let colour = null, sel;
  W.add(el, () => {
    const o = strip(), c = o?.colour || MAIN_COLOUR;
    if (c !== colour) { colour = c; el.style.setProperty("--c", c); }
    if (P.sel !== sel) { sel = P.sel; renderDevices(); }
  });
  return el;
}
function renderDevices() {
  D.clear();
  if (P.detail === "clip" && !clipAt(P.open)) P.detail = "devices";  // the clip went
  const clip = P.detail === "clip";
  root.classList.toggle("clipview", clip);
  if (clip) { mount($(".pd-chain", root)); renderRoll($(".pd-clip", root), D); } else { mount($(".pd-clip", root)); renderChain($(".pd-chain", root), D); }
  root.classList.toggle("bare", !clip && !owner(P.sel)?.devices.length);  // nothing on it: the chain folds to a bar
}
function flipDetail() { if (clipAt(P.open)) { P.detail = P.detail === "clip" ? "devices" : "clip"; redraw(); } }

const selectedDevice = () => { const o = P.dev != null && stripOfDevice(P.dev); return o ? [o, o.devices.find((d) => d.id === P.dev)] : []; };

// ---- keys; returns true when used
export function key(e) {
  const k = e.key;
  if (rollKey(e)) return true;
  if (k === "Tab" && e.shiftKey) { flipDetail(); return true; }
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
