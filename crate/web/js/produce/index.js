// Production mode: the transport across the top, the browser down the left, Clip or Timeline
// view in the middle (Tab switches), and the selected track's device chain along the bottom.
import { $, h, mount } from "../core/dom.js";
import { safe, toast } from "../core/api.js";
import { confirmSheet } from "../core/ui.js";
import { pref, setPref } from "../core/prefs.js";
import { Widgets, clockText, pbtn, text } from "../perform/controls.js";
import { studio } from "./engine.js";
import { P, addTrack, edit, loadSet, newSet, onRedraw, step, trackById } from "./set.js";
import { initBrowser } from "./browser.js";
import { renderClips } from "./clips.js";
import { drawTimeline, marker, renderTimeline } from "./timeline.js";

const W = new Widgets(), V = new Widgets();  // W: transport and devices, built once; V: the view, rebuilt per edit
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
  onRedraw(renderView);
  renderView();
}

function renderView() {
  const el = $(".pview", root);
  V.clear(); el.className = `pview ${P.view}`;
  (P.view === "clips" ? renderClips : renderTimeline)(el, V);
}

export function setView(v) { if (v === P.view) return; P.view = v; setPref("produceView", v); renderView(); }

function start() {
  if (raf) return;
  const frame = () => { W.sync(); V.sync(); if (P.view === "timeline") drawTimeline(); raf = requestAnimationFrame(frame); };
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
    pbtn(W, "+ Audio", () => edit(() => addTrack("audio")), { help: "<b>New audio track</b>" }),
    pbtn(W, "+ MIDI", () => edit(() => addTrack("midi")), { help: "<b>New MIDI track</b>  Instruments arrive with devices" }),
    pbtn(W, "New set", safe(async () => { if (await confirmSheet("Start a new set?", "This clears the tracks and clips. Undo can't bring them back.", "New set", true)) await newSet(); })));
}

// bars.beats.sixteenths, of the timeline while it plays, otherwise of the transport
function position() {
  const b = studio.ctx ? studio.songBeat() ?? studio.beatNow() : 0, bar = Math.floor(b / 4) + 1, beat = Math.floor(b % 4) + 1, six = Math.floor((b % 1) * 4) + 1;
  return `${bar}.${beat}.${six}`;
}

function togglePlay() { if (studio.song) studio.stopSong(); else studio.playSong(marker()); }
function stopEverything() { studio.stopSong(); studio.stopAll(true); studio.stopPreview(); }

// ---- the selected track's device chain (devices arrive next; the drop zone is where they'll go)
function devices() {
  const name = text(W, () => trackById(P.sel)?.name || "No track selected", "pd-name");
  const el = h("footer", { class: "pdevices" }, h("div", { class: "pd-title" }, name),
    h("div", { class: "pd-chain" }, h("div", { class: "pd-drop" }, "Drop audio effects here")));
  let shown = null;
  W.add(el, () => { const t = trackById(P.sel); if (t?.colour !== shown) { shown = t?.colour; el.style.setProperty("--c", shown || "#333"); } });
  return el;
}

// ---- keys; returns true when used
export function key(e) {
  const k = e.key;
  if (k === "Tab") { setView(P.view === "clips" ? "timeline" : "clips"); return true; }
  if (k === " ") { if (studio.busy) stopEverything(); else togglePlay(); return true; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "z") { step(!e.shiftKey); return true; }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "y") { step(false); return true; }
  if (k === "Delete" || k === "Backspace") {
    if (P.view === "timeline" && P.item) { const a = P.item; edit(() => { P.set.arrangement = P.set.arrangement.filter((x) => x !== a); P.item = null; }); return true; }
    if (P.view === "clips" && P.clip) { const [id, i] = P.clip, t = trackById(id); if (t?.clips[i]) { edit(() => { delete t.clips[i]; }); return true; } }
    return false;
  }
  if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "d" && P.view === "timeline" && P.item) {
    const a = P.item; edit(() => { const b = { ...structuredClone(a), start: a.start + a.length }; P.set.arrangement.push(b); P.item = b; });
    return true;
  }
  if (k === "Escape") { P.item = P.clip = null; studio.stopPreview(); renderView(); return true; }
  return false;
}
