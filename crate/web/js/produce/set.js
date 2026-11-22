// The open set: tracks, clip slots and the arrangement. Every edit goes through edit(), which
// keeps undo, saves (batched) and redraws; continuous drags (faders, knobs) use save() alone.
import { api, toast } from "../core/api.js";
import { UNITY, studio } from "./engine.js";
import { DEVICES } from "./fx/devices.js";

// sel: the strip whose devices show (a track's id, a return's letter or "main"); picked: the
// tracks selected together (Ctrl/Shift-click), for grouping; clip: selected [trackId, slot];
// item: selected arrangement clip; dev: selected device's id; open: the MIDI clip in the piano
// roll, by where it lives ({track, slot} or {item: index}), so undo never leaves it on a stale copy;
// detail: what the bottom panel shows, "devices" or "clip"
export const P = { set: null, view: "clips", sel: null, picked: new Set(), clip: null, item: null, dev: null, open: null, detail: "devices" };
const TRACK_COLOURS = ["#ff9f0a", "#ff6a3d", "#f05d8f", "#b07cff", "#7c8cff", "#3fb8af", "#5ccf6a", "#d6c84a"];  // as the server's new set
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
// for a knob: one undo step per gesture, however many values it passes through
let touching = 0;
export function touch() { if (!touching) checkpoint(); clearTimeout(touching); touching = setTimeout(() => { touching = 0; }, 600); }
export function step(back) {
  const from = back ? undo : redo, to = back ? redo : undo;
  if (!from.length) return;
  to.push(JSON.stringify(P.set)); P.set = JSON.parse(from.pop());
  P.item = null; attach(); save(); redraw();
}

// ---- open, new
export async function loadSet() { use(await api("project")); }
export async function newSet() { studio.stopAll(true); studio.stopSong(); undo.length = redo.length = 0; use(await api("project/new", {})); }
function use(set) { P.set = upgrade(set); P.sel = set.tracks[0]?.id ?? null; P.picked = new Set(); P.clip = P.item = P.dev = P.open = null; P.detail = "devices"; attach(); redraw(); }

// sets saved before returns, sends and devices existed, and (version 1) before instruments:
// an empty MIDI track then gets Crate FM, as a new one does
function upgrade(s) {
  s.returns ||= []; s.main.devices ||= [];
  s.returns.forEach((r, i) => { r.pan ??= 0; r.mute ??= false; r.devices ||= []; r.colour ||= RETURN_COLOURS[i % RETURN_COLOURS.length]; });
  for (const t of s.tracks) { t.sends ||= {}; t.devices ||= []; }
  if ((s.version || 1) < 2) {
    for (const t of s.tracks) if (t.kind === "midi" && !t.devices.length) t.devices.push({ id: s.next_id++, type: "fm", on: true, params: {} });
    s.version = 2;
  }
  return s;
}

// the engine reads the set directly: tempo, follow, the arrangement and every strip's mix
function attach() {
  const s = P.set;
  studio.bpm = s.bpm; studio.follow = s.follow; studio.arrangement = s.arrangement;
  studio.keepReturns(s.returns); studio.keepTracks(s.tracks);
  mixAll();
}
export function mixAll() {
  const s = P.set, how = { solo: audible(), returns: s.returns };
  for (const r of s.returns) studio.mix(r);
  for (const t of s.tracks) studio.mix(t, how);
  studio.mix(s.main);
}
// one strip after its level, a send or a device changed
export const remix = (o) => studio.mix(o, { solo: audible(), returns: P.set.returns });
studio.on((kind) => { if (kind === "reset" && P.set) attach(); });  // the output started over: send the set again

export const trackById = (id) => P.set.tracks.find((t) => t.id === id);

// ---- groups: a group is a track of kind "group"; its members carry `group: <its id>` and
// follow it in the list, nested groups included. Members play into the group's strip.
export const isGroup = (t) => t.kind === "group";
export const parentOf = (t) => (t.group ? trackById(t.group) : null);
function ancestors(t) { const out = []; for (let g = parentOf(t); g; g = parentOf(g)) out.push(g); return out; }
export const inside = (t, g) => ancestors(t).includes(g);
export const membersOf = (g) => P.set.tracks.filter((t) => inside(t, g));
export const depthOf = (t) => ancestors(t).length;
// what shows: tracks not inside a folded group
export const visibleTracks = () => P.set.tracks.filter((t) => !ancestors(t).some((g) => g.fold));
// a group and everything in it, in order
const withMembers = (t) => [t, ...(isGroup(t) ? membersOf(t) : [])];

// With anything soloed, the tracks that sound: each soloed track, everything inside a soloed
// group, and the groups a soloed track plays through. Null when nothing is soloed.
export function audible() {
  const solo = P.set.tracks.filter((t) => t.solo);
  if (!solo.length) return null;
  const ids = new Set();
  for (const t of solo) for (const x of [...withMembers(t), ...ancestors(t)]) ids.add(x.id);
  return ids;
}

// Group the picked tracks (with whatever's inside picked groups): a new group takes the first
// one's place and parent, and they follow it in their order.
export function groupTracks(ids) {
  const picked = P.set.tracks.filter((t) => ids.has(t.id));
  if (!picked.length) return null;
  const tops = picked.filter((t) => !ancestors(t).some((g) => ids.has(g.id))), moving = new Set(tops.flatMap(withMembers));
  const first = P.set.tracks.find((t) => moving.has(t)), id = P.set.next_id++;
  const g = { id, name: "Group", kind: "group", colour: TRACK_COLOURS[(id - 1) % TRACK_COLOURS.length], group: first.group,
    volume: UNITY, pan: 0, mute: false, solo: false, fold: false, clips: {}, sends: {}, devices: [] };
  const rest = P.set.tracks.filter((t) => !moving.has(t)), at = P.set.tracks.indexOf(first) - P.set.tracks.slice(0, P.set.tracks.indexOf(first)).filter((t) => moving.has(t)).length;
  for (const t of tops) t.group = id;
  rest.splice(at, 0, g, ...P.set.tracks.filter((t) => moving.has(t)));
  P.set.tracks = rest; P.sel = id; P.picked = new Set([id]);
  return g;
}
// its members move up to its own parent and the group goes
export function ungroup(g) {
  for (const t of P.set.tracks) if (t.group === g.id) t.group = g.group;
  removeTrack(g, false);
}

// ---- strips: a track, a return or Main, by the key P.sel holds
export const keyOf = (o) => (o === P.set.main ? "main" : o.id);
export const owner = (key) => (key === "main" ? P.set.main : typeof key === "string" ? P.set.returns.find((r) => r.id === key) : trackById(key));
export const nameOf = (o) => (o === P.set.main ? "Main" : o.name);

// ---- returns: lettered A to L, as in Ableton
const RETURN_COLOURS = ["#7c8cff", "#3fb8af", "#b07cff", "#d6c84a"];
const LETTERS = "ABCDEFGHIJKL";
export function addReturn() {
  const used = new Set(P.set.returns.map((r) => r.id)), id = [...LETTERS].find((l) => !used.has(l));
  if (!id) return null;
  const r = { id, name: `${id} Return`, colour: RETURN_COLOURS[P.set.returns.length % RETURN_COLOURS.length], volume: UNITY, pan: 0, mute: false, devices: [] };
  P.set.returns.push(r); P.sel = id;
  return r;
}
export function removeReturn(r) {
  P.set.returns = P.set.returns.filter((x) => x !== r);
  for (const t of P.set.tracks) delete t.sends[r.id];
  if (P.sel === r.id) P.sel = P.set.tracks[0]?.id ?? "main";
}

// ---- devices on a strip. Parameters are stored only where they differ from the default.
// An instrument goes first on a MIDI track, in place of the one there; an empty audio track
// becomes a MIDI track to take it. `preset`: {name, params} to start from. Returns null where it can't go.
export function addDevice(o, type, at = o.devices.length, preset = null) {
  const def = DEVICES[type], d = { id: P.set.next_id++, type, on: true, params: structuredClone(preset?.params || {}), ...(preset ? { preset: preset.name } : {}) };
  if (def.instrument) {
    if (o.kind === "audio" && !Object.keys(o.clips).length && !P.set.arrangement.some((a) => a.track === o.id)) o.kind = "midi";
    if (o.kind !== "midi") { toast("Instruments go on MIDI tracks"); return null; }
    o.devices = o.devices.filter((x) => !DEVICES[x.type]?.instrument); at = 0;
  } else if (o.id && typeof o.id === "string" && def.params.some((p) => p.k === "mix")) d.params.mix = 1;  // on a return, all wet
  o.devices.splice(at, 0, d); P.dev = d.id;
  return d;
}
export function setParam(o, d, p, v) {
  if (v === p.def) delete d.params[p.k]; else d.params[p.k] = v;
  remix(o); save();
}
export function removeDevice(o, d) { o.devices = o.devices.filter((x) => x !== d); if (P.dev === d.id) P.dev = null; }
export function duplicateDevice(o, d) {
  const c = { ...structuredClone(d), id: P.set.next_id++ };
  o.devices.splice(o.devices.indexOf(d) + 1, 0, c); P.dev = c.id;
  return c;
}
export const stripOfDevice = (id) => [...P.set.tracks, ...P.set.returns, P.set.main].find((o) => o.devices.some((d) => d.id === id));

export function addTrack(kind = "audio", name = "") {
  const id = P.set.next_id++;
  const t = { id, name: name || `${P.set.tracks.length + 1} ${kind === "midi" ? "MIDI" : "Audio"}`, kind, colour: TRACK_COLOURS[(id - 1) % TRACK_COLOURS.length],
    volume: UNITY, pan: 0, mute: false, solo: false, clips: {}, sends: {}, devices: [] };
  P.set.tracks.push(t); P.sel = id;
  if (kind === "midi") addDevice(t, "fm");  // something to hear the moment notes go in
  return t;
}

// ---- MIDI clips: notes {p: pitch, s: start, l: length (beats), v: velocity 1–127}
export const newMidiClip = (beats = 4) => ({ name: "MIDI", notes: [], beats, loop: true });
export const isMidi = (clip) => !!clip?.notes;
// the clip at a place, and the track it plays on
export function clipAt(at) {
  if (!at || !P.set) return null;
  if (at.item != null) { const a = P.set.arrangement[at.item]; return a?.clip.notes ? { clip: a.clip, track: trackById(a.track), item: a } : null; }
  const t = trackById(at.track), clip = t?.clips[at.slot];
  return clip?.notes ? { clip, track: t } : null;
}
export function openClip(at) { P.open = at; P.detail = "clip"; P.sel = clipAt(at)?.track.id ?? P.sel; }
// a group goes with everything in it, unless `members` is false (ungrouping)
export function removeTrack(t, members = true) {
  const gone = new Set((members ? withMembers(t) : [t]).map((x) => x.id));
  for (const id of gone) studio.stopTrack({ id }, true);
  P.set.tracks = P.set.tracks.filter((x) => !gone.has(x.id));
  P.set.arrangement = P.set.arrangement.filter((a) => !gone.has(a.track));
  for (const id of gone) P.picked.delete(id);
  if (gone.has(P.sel)) P.sel = P.set.tracks[0]?.id ?? null;
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
