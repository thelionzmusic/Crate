// Library state, data loading and the export loudness target. Loaders announce what
// changed on the bus; views listen and redraw themselves.
import { api } from "./core/api.js";
import { emit } from "./core/bus.js";
import { pref } from "./core/prefs.js";
import { did } from "./core/undo.js";

export const S = {
  rows: [], byId: new Map(), nodes: [], thumbs: new Map(),
  view: { kind: "all" }, sort: { key: null, dir: 1 }, query: "",
  list: [], sel: new Set(), anchor: null,
  settings: {}, state: {}, dupes: null, wishlist: [], drives: [], onStick: new Set(),
  open: new Set(pref("open", [])), widths: pref("widths", {}), colOrder: pref("colOrder", []), searches: pref("searches", []), hidden: new Set(pref("hiddenCols", ["label", "plays"])),
};

export const nodeById = (id) => S.nodes.find((n) => n.id === id);

// ---- loading
export async function loadState() {
  S.state = await api("state"); S.settings = S.state.settings;
  computeTarget(); emit("state");
}
// Tracks arrive whole the first time (and with full=true), and after that as just the rows
// changed since the version we hold, merged in place.
let tracksV = "";
export async function loadTracks(full = false) {
  const d = await api(`tracks/${full ? "" : tracksV}`);
  if (d.same) return;
  tracksV = String(d.v);
  const rows = d.rows.map((r) => Object.fromEntries(d.cols.map((c, i) => [c, r[i]])));
  if (d.delta) {
    const gone = new Set(d.removed);
    for (const t of rows) { const old = S.byId.get(t.id); if (old) Object.assign(old, t); else { S.rows.push(t); S.byId.set(t.id, t); } }
    if (gone.size) { S.rows = S.rows.filter((t) => !gone.has(t.id)); gone.forEach((id) => S.byId.delete(id)); }
    if (!rows.length && !gone.size) return;
  } else {
    S.rows = rows;
    S.byId = new Map(S.rows.map((t) => [t.id, t]));
  }
  computeTarget(); emit("tracks");
}
export async function loadNodes() { S.nodes = await api("nodes"); emit("nodes"); }

// every change to a playlist's tracks goes through here, so it can be undone
export async function setNodeTracks(n, tracks, label) {
  const before = n.tracks;
  await api("node/tracks", { id: n.id, tracks }); n.tracks = tracks; emit("nodes");
  did(label, async () => { await api("node/tracks", { id: n.id, tracks: before }); n.tracks = before; emit("nodes"); });
}

// the same edit to several tracks (genre, comment, colour...), undoable as one step
export async function editTracks(ids, fields, label = "Edit") {
  const before = ids.map((id) => [id, Object.fromEntries(Object.keys(fields).map((k) => [k, S.byId.get(id)?.[k] ?? null]))]);
  await api("tracks/edit", { ids, fields }); await loadTracks();
  did(label, async () => { for (const [id, f] of before) await api("track", { id, fields: f }); await loadTracks(); });
}
export async function loadThumbs() {
  const buf = new Uint8Array(await (await fetch("/api/thumbs")).arrayBuffer()), rec = 4 + 96 * 3;
  for (let o = 0; o + rec <= buf.length; o += rec) S.thumbs.set(buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24), buf.subarray(o + 4, o + rec));
  emit("thumbs");
}
// tracks on the sticks plugged in, marked in the list
export async function loadOnStick() { S.onStick = new Set(await api("onstick")); emit("onstick"); }
export async function reloadAll() { await loadState(); await loadTracks(true); await loadNodes(); loadThumbs(); }

// ---- navigation
export function setView(view) {
  S.view = view; S.sel.clear();
  S.sort = { key: view.kind === "node" && !(nodeById(view.id) || {}).rules ? "pos" : null, dir: 1 };
  emit("view", { rebuild: true });
}

// ---- loudness target for export: mirrors crate/library.py
let target = -10;
export const targetLufs = () => target;
function computeTarget() {
  const ceil = +S.settings.ceiling;
  if (S.settings.target_mode !== "auto") { target = +S.settings.target_lufs; return; }
  const reach = S.rows.filter((t) => t.lufs != null && t.lufs > -70).map((t) => t.lufs + ceil - t.true_peak).sort((a, b) => a - b);
  target = reach.length ? Math.min(-8, Math.max(-14, Math.round(reach[Math.floor(reach.length * 0.1)] * 10) / 10)) : -10;
}
export function recomputeTarget() { computeTarget(); }
// plain gain to reach the target, held back so the true peak stays under the ceiling
export function gainFor(t) {
  if (!t || t.lufs == null) return null;
  const want = target - t.lufs, room = +S.settings.ceiling - t.true_peak;
  return want > room ? { db: room, cap: true } : { db: want, cap: false };
}
