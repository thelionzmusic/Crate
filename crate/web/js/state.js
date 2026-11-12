// Library state, data loading and the export loudness target. Loaders announce what
// changed on the bus; views listen and redraw themselves.
import { api } from "./core/api.js";
import { emit } from "./core/bus.js";
import { pref } from "./core/prefs.js";

export const S = {
  rows: [], byId: new Map(), nodes: [], thumbs: new Map(),
  view: { kind: "all" }, sort: { key: null, dir: 1 }, query: "",
  list: [], sel: new Set(), anchor: null,
  settings: {}, state: {}, dupes: null, wishlist: [],
  open: new Set(pref("open", [])), widths: pref("widths", {}), hidden: new Set(pref("hiddenCols", ["label", "plays"])),
};

export const nodeById = (id) => S.nodes.find((n) => n.id === id);

// ---- loading
export async function loadState() {
  S.state = await api("state"); S.settings = S.state.settings;
  computeTarget(); emit("state");
}
let tracksV = "";
export async function loadTracks() {
  const d = await api(`tracks/${tracksV}`);
  if (d.same) return;
  tracksV = d.v;
  S.rows = d.rows.map((r) => Object.fromEntries(d.cols.map((c, i) => [c, r[i]])));
  S.byId = new Map(S.rows.map((t) => [t.id, t]));
  computeTarget(); emit("tracks");
}
export async function loadNodes() { S.nodes = await api("nodes"); emit("nodes"); }
export async function loadThumbs() {
  const buf = new Uint8Array(await (await fetch("/api/thumbs")).arrayBuffer()), rec = 4 + 96 * 3;
  for (let o = 0; o + rec <= buf.length; o += rec) S.thumbs.set(buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24), buf.subarray(o + 4, o + rec));
  emit("thumbs");
}
export async function reloadAll() { await loadState(); await loadTracks(); await loadNodes(); loadThumbs(); }

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
