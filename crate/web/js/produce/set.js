// The open set: tracks, clip slots and the arrangement. Every edit goes through edit(), which
// keeps undo, saves (batched) and redraws; continuous drags (faders, knobs) use save() alone.
import { api, toast } from "../core/api.js";
import { studio } from "./engine.js";

export const P = { set: null, view: "clips", sel: null, clip: null, item: null };  // clip: selected [trackId, slot]; item: selected arrangement clip
export const TRACK_COLOURS = ["#ff9f0a", "#ff6a3d", "#f05d8f", "#b07cff", "#7c8cff", "#3fb8af", "#5ccf6a", "#d6c84a"];  // as the server's new set
const BAR = 4, UNDO_MAX = 100;

const redraws = new Set();
export const onRedraw = (fn) => redraws.add(fn);
export const redraw = () => { for (const fn of redraws) fn(); };

let saving = 0;
export function save() { clearTimeout(saving); saving = setTimeout(() => api("project", P.set).catch((e) => toast(e.message)), 500); }

// ---- undo: the set is small, so each step is a snapshot
const undo = [], redo = [];
export function edit(fn) { checkpoint(); fn(); attach(); save(); redraw(); }
// for a drag: the state before it is the undo step, and the drag commits with save() + redraw()
export function checkpoint() { undo.push(JSON.stringify(P.set)); if (undo.length > UNDO_MAX) undo.shift(); redo.length = 0; }
export function step(back) {
  const from = back ? undo : redo, to = back ? redo : undo;
  if (!from.length) return;
  to.push(JSON.stringify(P.set)); P.set = JSON.parse(from.pop());
  P.item = null; attach(); save(); redraw();
}

// ---- open, new
export async function loadSet() { use(await api("project")); }
export async function newSet() { studio.stopAll(true); studio.stopSong(); undo.length = redo.length = 0; use(await api("project/new", {})); }
function use(set) { P.set = set; P.sel = set.tracks[0]?.id ?? null; P.clip = P.item = null; attach(); redraw(); }

// the engine reads the set directly: tempo, follow, the arrangement and each track's mix
function attach() {
  const s = P.set, solo = soloed();
  studio.bpm = s.bpm; studio.follow = s.follow; studio.arrangement = s.arrangement;
  for (const t of s.tracks) studio.mix(t, solo);
  studio.setMain(s.main.volume);
}
export const mixAll = () => { const solo = soloed(); for (const t of P.set.tracks) studio.mix(t, solo); };

export const trackById = (id) => P.set.tracks.find((t) => t.id === id);
export const soloed = () => P.set.tracks.some((t) => t.solo);

export function addTrack(kind = "audio", name = "") {
  const id = P.set.next_id++;
  const t = { id, name: name || `${id} ${kind === "midi" ? "MIDI" : "Audio"}`, kind, colour: TRACK_COLOURS[(id - 1) % TRACK_COLOURS.length],
    volume: 0.85, pan: 0, mute: false, solo: false, clips: {}, devices: [] };
  P.set.tracks.push(t); P.sel = id;
  return t;
}
export function removeTrack(t) {
  studio.stopTrack(t, true);
  P.set.tracks = P.set.tracks.filter((x) => x !== t);
  P.set.arrangement = P.set.arrangement.filter((a) => a.track !== t.id);
  if (P.sel === t.id) P.sel = P.set.tracks[0]?.id ?? null;
}

// A dragged item as a clip: a sample, a library track, or a copy of another clip. Library
// tracks keep their analysed tempo and start on their first bar line; a sample's tempo comes
// from its name ("128 bpm") or, for a loop, from fitting it to a power-of-two number of beats
// at the set's tempo. Anything under 1.2 s is a one-shot: it plays once, unstretched.
export async function makeClip(item) {
  if (item.kind === "clip") return structuredClone(item.clip);
  const src = item.kind === "track" ? { kind: "track", id: item.id } : { kind: "sample", f: item.f, p: item.p };
  const [buf, t] = await Promise.all([studio.load(src), item.kind === "track" ? api(`track/${item.id}`) : null]);
  const dur = buf.duration, name = t ? t.title : item.p.split("/").pop().replace(/\.[^.]+$/, "");
  let bpm = t?.bpm || bpmIn(name), offset = 0, loop = true, beats;
  if (t && bpm) {
    const period = 60 / bpm;
    offset = (t.first_beat_ms || 0) / 1000 + ((((-(t.downbeat || 0)) % BAR) + BAR) % BAR) * period;
    beats = Math.max(BAR, Math.floor((dur - offset) / period / BAR) * BAR);
  } else if (bpm) {
    beats = Math.max(1, Math.round(dur * bpm / 60));
  } else if (dur < 1.2) {
    loop = false; beats = Math.max(1, Math.ceil(dur * studio.tempo() / 60));
  } else {
    beats = 2 ** Math.round(Math.log2(dur * studio.tempo() / 60));
    bpm = beats * 60 / dur;
  }
  return { name, src, bpm: bpm || null, beats, loop, offset };
}
const bpmIn = (name) => { const m = name.match(/(?:^|\D)(\d{2,3})\s?bpm/i), v = m && +m[1]; return v >= 60 && v <= 200 ? v : null; };

// the item being dragged, readable on drop without depending on the browser's data transfer
export const drag = { item: null };
export const DRAG_TYPE = "text/crate-produce";
