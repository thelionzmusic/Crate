// The track list: columns that stretch to fit, filtering, sorting, selection, and a
// virtualised body that reuses row elements, so scrolling never rebuilds them.
import { $, $$, h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { emit, on } from "../core/bus.js";
import { confirmSheet, menu } from "../core/ui.js";
import { pref, setPref } from "../core/prefs.js";
import { artBg, camelotColor, energyBar, fmtChip, fmtTime, mixesWith } from "../core/format.js";
import { mini } from "../core/wave.js";
import { S, gainFor, loadNodes, loadTracks, nodeById } from "../state.js";
import { mode, DECK_LETTERS } from "../mode.js";
import { pollSoon } from "../jobs.js";
import { audio, deck, redoCues } from "./preview.js";
import { renderDupes, renderWish } from "./views.js";
import { addFolder, importRekordbox } from "../sheets/music.js";
import { storeSheet } from "../sheets/store.js";
import { buildSetSheet } from "../sheets/setbuilder.js";

// ---- columns
const COLUMNS = [
  { key: "art", label: "", w: 40, fixed: true, render: (t) => h("span", { class: "thumb", style: artBg(t) }) },
  { key: "pos", label: "#", w: 40, cls: "num t3" },
  { key: "title", label: "Title", w: 240, cls: "ttl" },
  { key: "artist", label: "Artist", w: 160, cls: "t2" },
  { key: "wave", label: "Waveform", w: 130, render: (t) => (S.thumbs.has(t.id) ? mini(S.thumbs.get(t.id)) : "") },
  { key: "bpm", label: "BPM", w: 64, cls: "num", render: (t) => (t.bpm ? (t.variable ? h("span", { title: "Variable tempo" }, `~${Math.round(t.bpm)}`) : t.bpm.toFixed(t.bpm % 1 ? 2 : 0)) : "") },
  { key: "camelot", label: "Key", w: 62, render: (t) => (t.camelot ? h("span", { class: "key" + (mixesWith(deck.t, t) ? " match" : ""), style: `--kc:${camelotColor(t.camelot)}`, title: t.key }, t.camelot) : t.key || "") },
  { key: "energy", label: "Energy", w: 76, render: (t) => energyBar(t.energy) },
  { key: "duration", label: "Time", w: 58, cls: "num t2", render: (t) => fmtTime(t.duration) },
  { key: "lufs", label: "LUFS", w: 60, cls: "num t2", render: (t) => (t.lufs != null ? t.lufs.toFixed(1) : t.error || t.analysed ? "" : "…") },
  { key: "gain", label: "Level", w: 64, cls: "num", render: (t) => { const g = gainFor(t); return g ? h("span", { class: "t2", title: g.cap ? "Boost held back by the true-peak ceiling so nothing clips" : "Gain applied to the copy on export" }, (g.db > 0 ? "+" : "") + g.db.toFixed(1)) : ""; } },
  { key: "genre", label: "Genre", w: 110, cls: "t2" },
  { key: "label", label: "Label", w: 110, cls: "t2" },
  { key: "format", label: "Format", w: 108, cls: "t3", render: (t) => h("span", {}, fmtChip(t), t.sample_rate ? `${(t.sample_rate / 1000).toFixed(1)}k` : "") },
  { key: "plays", label: "Plays", w: 46, cls: "num t3" },
  { key: "date_added", label: "Added", w: 100, cls: "t3" },
  { key: "issues", label: "", w: 36, fixed: true, render: (t) => (t.issues && t.issues.length ? h("span", { class: "flag", title: t.issues.join("\n") }, icon("i-warn", "i sm")) : "") },
];
const PROBLEM = { key: "problem", label: "Problem", w: 480, render: (t) => h("span", { class: "problem", title: (t.issues || []).join("\n") }, (t.issues || []).join("  ·  ")) };
const STRETCH = { title: 4, artist: 3, problem: 4, genre: 1.2, label: 1.2 }, MIN_W = { title: 170, artist: 110, problem: 240 };

function visibleCols() {
  const cols = COLUMNS.filter((c) => !S.hidden.has(c.key));
  if (S.view.kind !== "issues") return cols;
  cols.splice(cols.findIndex((c) => c.key === "artist") + 1, 0, PROBLEM);
  return cols.filter((c) => !["wave", "genre", "date_added", "issues"].includes(c.key));
}
// spare width goes to the text columns, unless you've sized them yourself
let widths = new Map(), cols = [], total = 0;
function layout() {
  const sc = $("#scroller"); cols = visibleCols();
  const base = cols.reduce((s, c) => s + (S.widths[c.key] || c.w), 0), extra = sc ? sc.clientWidth - 10 - base : 0;
  const wt = cols.reduce((s, c) => s + (S.widths[c.key] ? 0 : STRETCH[c.key] || 0), 0);
  widths = new Map(cols.map((c) => { const w = S.widths[c.key] || c.w, k = !S.widths[c.key] && STRETCH[c.key];
    return [c.key, Math.floor(k && wt ? Math.max(MIN_W[c.key] || 80, w + extra * k / wt) : w)]; }));
  total = cols.reduce((s, c) => s + widths.get(c.key), 0);
}
const saveWidths = () => setPref("widths", S.widths);

// ---- filtering and sorting
function parseQuery(q) {
  const f = { text: [] };
  for (const tok of q.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    let m;
    if ((m = /^bpm:(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?$/.exec(tok))) f.bpm = [+m[1], +(m[2] || m[1])];
    else if ((m = /^key:(\d+[ab])$/.exec(tok))) f.key = m[1].toUpperCase();
    else if ((m = /^energy:(\d+)(?:-(\d+))?$/.exec(tok))) f.energy = [+m[1], +(m[2] || 10)];
    else f.text.push(tok);
  }
  return f;
}
function viewIds() {
  if (S.view.kind === "node") return (nodeById(S.view.id) || { tracks: [] }).tracks;
  if (S.view.kind === "issues") return S.rows.filter((t) => t.issues && t.issues.length).map((t) => t.id);
  return S.rows.map((t) => t.id);
}
function viewTitle() {
  const v = S.view;
  if (v.kind === "all") return ["Collection", `${S.rows.length} tracks`];
  if (v.kind === "issues") return ["Issues", "Tracks worth fixing before they reach a club system"];
  const n = nodeById(v.id);
  return n ? [n.name, n.rules ? `Smart playlist, ${n.tracks.length} tracks` : `${n.tracks.length} tracks`] : ["", ""];
}
export function refresh() {
  const panel = $("#listPanel");
  if (S.view.kind === "dupes") return renderDupes(panel);
  if (S.view.kind === "wish") return renderWish(panel);
  if (!$("#rows")) build(panel);
  const [title, sub] = viewTitle();
  $("#lhTitle").textContent = title; $("#lhSub").textContent = sub;
  const f = parseQuery(S.query);
  let list = viewIds().map((id, i) => ({ t: S.byId.get(id), pos: i + 1 })).filter((x) => x.t);
  if (f.text.length) list = list.filter(({ t }) => { const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.label} ${t.remixer} ${t.comment}`.toLowerCase(); return f.text.every((w) => hay.includes(w)); });
  if (f.bpm) list = list.filter(({ t }) => t.bpm >= f.bpm[0] - 0.005 && t.bpm <= f.bpm[1] + 0.005);
  if (f.key) list = list.filter(({ t }) => t.camelot === f.key);
  if (f.energy) list = list.filter(({ t }) => t.energy >= f.energy[0] && t.energy <= f.energy[1]);
  const { key, dir } = S.sort;
  if (key && key !== "pos") {
    const val = (x) => (key === "gain" ? (gainFor(x.t) || { db: -99 }).db : key === "format" ? x.t.codec : key === "issues" ? (x.t.issues || []).length : x.t[key]);
    list.sort((a, b) => { const A = val(a), B = val(b); if (A == null || A === "") return 1; if (B == null || B === "") return -1;
      return (typeof A === "string" ? A.localeCompare(B, undefined, { numeric: true, sensitivity: "base" }) : A - B) * dir; });
  } else if (key === "pos" && dir < 0) list.reverse();
  S.list = list; renderCols(); renderRows();
}

// ---- structure
let ROW = pref("compact", "") ? 27 : 34;
document.documentElement.classList.toggle("compact", ROW === 27);
function setDensity(compact) {
  ROW = compact ? 27 : 34; document.documentElement.classList.toggle("compact", compact); setPref("compact", compact ? 1 : null);
  $$(".dens .btn").forEach((b) => b.classList.toggle("on", (b.dataset.d === "c") === compact)); renderRows();
}
const rowAt = (e) => { const r = e.target.closest(".r"); return r ? +r.dataset.i : null; };
const plainPlaylist = () => S.view.kind === "node" && !(nodeById(S.view.id) || {}).rules;
function build(panel) {
  mount(panel,
    h("div", { class: "listhead" }, h("h2", { id: "lhTitle" }), h("span", { class: "sub", id: "lhSub" }), h("div", { class: "spacer" }), h("span", { id: "lhActions" }),
      h("div", { class: "seg dens", "data-help": "<b>Row size</b>  Comfortable or compact" },
        h("button", { class: "btn sm" + (ROW === 34 ? " on" : ""), "data-d": "r", onclick: () => setDensity(false) }, "Comfortable"),
        h("button", { class: "btn sm" + (ROW === 27 ? " on" : ""), "data-d": "c", onclick: () => setDensity(true) }, "Compact"))),
    h("div", { class: "cols", id: "cols", oncontextmenu: (e) => { e.preventDefault(); colMenu(e); } }),
    h("div", { class: "scroller", id: "scroller", tabindex: 0 }, h("div", { class: "rows", id: "rows" })));
  const sc = $("#scroller"), rows = $("#rows");
  let pending = false;
  sc.addEventListener("scroll", () => { $("#cols").scrollLeft = sc.scrollLeft; if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; renderRows(); }); } }, { passive: true });
  rows.addEventListener("pointerdown", (e) => {
    const i = rowAt(e); if (i == null || e.button > 2) return;
    const id = S.list[i].t.id;
    if (e.shiftKey && S.anchor != null) { const [a, b] = [Math.min(S.anchor, i), Math.max(S.anchor, i)]; if (!e.ctrlKey) S.sel.clear(); for (let k = a; k <= b; k++) S.sel.add(S.list[k].t.id); }
    else if (e.ctrlKey || e.metaKey) { S.sel.has(id) ? S.sel.delete(id) : S.sel.add(id); S.anchor = i; }
    else if (!S.sel.has(id) || (e.button === 0 && S.sel.size <= 1)) { S.sel = new Set([id]); S.anchor = i; }
    renderRows();
  });
  rows.addEventListener("dblclick", (e) => { const i = rowAt(e); if (i != null) emit("open", { id: S.list[i].t.id }); });
  rows.addEventListener("contextmenu", (e) => { const i = rowAt(e); if (i == null) return; e.preventDefault(); trackMenu(e, S.list[i].t); });
  rows.addEventListener("dragstart", (e) => {
    const i = rowAt(e); if (i == null) return;
    if (!S.sel.has(S.list[i].t.id)) { S.sel = new Set([S.list[i].t.id]); renderRows(); }
    e.dataTransfer.setData("text/crate-ids", JSON.stringify([...S.sel])); e.dataTransfer.effectAllowed = "copyMove";
  });
  rows.addEventListener("dragover", (e) => {
    if (!plainPlaylist() || (S.sort.key && S.sort.key !== "pos")) return;
    e.preventDefault(); $$(".dropline").forEach((x) => x.classList.remove("dropline")); e.target.closest(".r")?.classList.add("dropline");
  });
  rows.addEventListener("drop", safe(async (e) => {
    $$(".dropline").forEach((x) => x.classList.remove("dropline"));
    if (!plainPlaylist()) return; const i = rowAt(e); if (i == null) return; e.preventDefault(); e.stopPropagation();
    const moving = JSON.parse(e.dataTransfer.getData("text/crate-ids") || "[]"), node = nodeById(S.view.id), before = S.list[i].t.id;
    const rest = node.tracks.filter((t) => !moving.includes(t)), at = rest.indexOf(before);
    rest.splice(at < 0 ? rest.length : at, 0, ...moving);
    await api("node/tracks", { id: node.id, tracks: rest }); node.tracks = rest; refresh();
  }));
}

function renderCols() {
  const el = $("#cols"); if (!el) return;
  layout();
  const isNode = S.view.kind === "node";
  mount(el, ...cols.map((c) => {
    const cell = h("div", { class: (c.cls || "").includes("num") ? "num" : "", style: `width:${widths.get(c.key)}px` }, c.key === "pos" && !isNode ? "#" : c.label);
    if (S.sort.key === c.key) { cell.classList.add("on"); cell.append(h("span", { class: "arr" }, S.sort.dir > 0 ? "↑" : "↓")); }
    if (c.label) cell.onclick = () => { S.sort = { key: c.key, dir: S.sort.key === c.key ? -S.sort.dir : 1 }; refresh(); };
    if (!c.fixed) cell.append(grip(c));
    return cell;
  }));
}
function grip(c) {  // drag a column's right edge to size it; double-click to let it stretch again
  const g = h("span", { class: "grip", "data-help": "<b>Resize</b>  Drag the edge. Double-click to let it stretch again" });
  g.onpointerdown = (e) => {
    e.stopPropagation(); e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add("drag");
    const x0 = e.clientX, w0 = widths.get(c.key);
    g.onpointermove = (ev) => { S.widths[c.key] = Math.max(40, w0 + ev.clientX - x0); renderCols(); renderRows(); };
    g.onpointerup = () => { g.onpointermove = null; saveWidths(); };
  };
  g.ondblclick = (e) => { e.stopPropagation(); delete S.widths[c.key]; saveWidths(); renderCols(); renderRows(); };
  g.onclick = (e) => e.stopPropagation();
  return g;
}
function colMenu(e) {
  menu(e, COLUMNS.filter((c) => c.label && c.key !== "title").map((c) => ({ label: c.label, icon: S.hidden.has(c.key) ? null : "i-chev",
    run: () => { S.hidden.has(c.key) ? S.hidden.delete(c.key) : S.hidden.add(c.key); setPref("hiddenCols", [...S.hidden]); refresh(); } })));
}

// ---- rows: built once per track and layout, then only moved and re-classed
const cache = new Map();
let cacheKey = "", matchKey = "";
const eq = h("span", { class: "eq", "aria-label": "Playing" }, h("i"), h("i"), h("i"));
function row(t) {
  let r = cache.get(t.id);
  if (r) return r;
  r = h("div", { draggable: "true" }, ...cols.map((c) => h("div", { class: c.cls || "", style: `width:${widths.get(c.key)}px` }, c.key === "pos" ? "" : c.render ? c.render(t) : t[c.key] ?? "")));
  r.posCell = r.children[cols.findIndex((c) => c.key === "pos")] || null;
  r.missing = !!(t.issues && t.issues.some((x) => x.startsWith("File not found")));
  cache.set(t.id, r);
  return r;
}
export function invalidateRows() { cache.clear(); }
export function renderRows() {
  const sc = $("#scroller"), rows = $("#rows"); if (!rows) return;
  layout();
  const key = `${cols.map((c) => `${c.key}:${widths.get(c.key)}`).join()}|${ROW}`, mk = `${deck.id}|${deck.t?.camelot}|${deck.t?.bpm}`;
  if (key !== cacheKey || mk !== matchKey) { cache.clear(); cacheKey = key; matchKey = mk; }
  rows.style.height = `${S.list.length * ROW}px`; rows.style.width = `${total}px`;
  if (!S.list.length) { mount(rows, emptyState()); return; }
  const first = Math.max(0, Math.floor(sc.scrollTop / ROW) - 6), last = Math.min(S.list.length, first + Math.ceil(sc.clientHeight / ROW) + 12);
  const out = [];
  eq.classList.toggle("paused", audio.paused);
  for (let i = first; i < last; i++) {
    const { t, pos } = S.list[i], r = row(t), loaded = deck.id === t.id;
    r.className = `r${S.sel.has(t.id) ? " sel" : ""}${loaded ? " loaded" : ""}${r.missing ? " missing" : ""}`;
    r.style.cssText = `top:${i * ROW}px;width:${total}px`; r.dataset.i = i;
    if (r.posCell) { if (loaded) mount(r.posCell, eq); else r.posCell.textContent = S.view.kind === "node" ? pos : i + 1; }
    out.push(r);
  }
  rows.replaceChildren(...out);
}
function emptyState() {
  if (!S.rows.length) return h("div", { class: "empty" }, icon("logo", "logo"), h("strong", {}, "Bring your music in"),
    h("p", {}, "Add a folder or import your rekordbox collection. Crate analyses every track on all your CPU cores: tempo, key, phrases, cues, vocals, loudness and sound quality."),
    h("div", { style: "display:flex;gap:6px" }, h("button", { class: "btn primary", onclick: addFolder }, icon("i-plus"), "Add music folder"), h("button", { class: "btn", onclick: importRekordbox }, icon("i-import"), "Import from rekordbox")));
  const [strong, p] = S.view.kind === "issues" ? ["No issues", "Every track is where it should be, analysed, and sounds right."]
    : S.view.kind === "node" ? ((nodeById(S.view.id) || {}).rules ? ["Nothing matches yet", "Edit the rules from the playlist's menu, or add more music."] : ["Empty playlist", "Drag tracks from Collection onto this playlist."])
      : ["No matches", "Try a different search."];
  return h("div", { class: "empty" }, h("strong", {}, strong), h("p", {}, p));
}

// ---- actions on tracks
const selection = (t) => (S.sel.size ? [...S.sel] : [t.id]);
function trackMenu(e, t) {
  const ids = selection(t), node = S.view.kind === "node" ? nodeById(S.view.id) : null;
  menu(e, [
    ...(mode.perform
      ? DECK_LETTERS.slice(0, mode.decks).map((k, i) => ({ label: `Load to deck ${k}`, icon: "i-deck", kbd: i < 2 ? `Shift+${i ? "Right" : "Left"}` : "", run: () => emit("open", { id: t.id, deck: k }) }))
      : [{ label: "Load", icon: "i-play", kbd: "Enter", run: () => emit("open", { id: t.id }) }]),
    { label: "Build a set from here", icon: "i-set", run: () => buildSetSheet(t.id) },
    "-",
    t.issues && t.issues.length ? { label: "Find a better copy", icon: "i-store", run: () => storeSheet(t) } : null,
    { label: "Search the stores", icon: "i-store", run: () => storeSheet(t) },
    { label: "Add to wishlist", icon: "i-heart", run: safe(async () => { await api("wish", { artist: t.artist, title: t.title, track_id: t.id }); toast(`${t.title} is on your wishlist`); }) },
    { label: "Show in Explorer", icon: "i-reveal", run: safe(() => api("reveal", { id: t.id })) },
    "-",
    { label: "Analyse again", run: safe(async () => { await api("analyse", { ids }); pollSoon(); }) },
    { label: ids.length > 1 ? `Redo smart cues on ${ids.length} tracks` : "Redo smart cues", icon: "i-cue", run: safe(async () => {
      if (!await confirmSheet(ids.length > 1 ? `Redo smart cues on ${ids.length} tracks?` : "Redo smart cues?",
        "Every cue on these tracks is replaced with Crate's layout: A mix in, B build, C drop, D breakdown, E second build, F second drop, G mix out, H intro loop. Cues you set yourself are removed too.", "Redo cues", true)) return;
      await redoCues(ids); pollSoon();
    }) },
    node && !node.rules ? { label: "Remove from playlist", kbd: "Del", run: removeFromPlaylist } : null,
    { label: ids.length > 1 ? `Remove ${ids.length} from library` : "Remove from library", danger: true, run: removeFromLibrary },
  ]);
}
const removeFromPlaylist = safe(async () => {
  const node = nodeById(S.view.id); if (!node || node.rules) return;
  node.tracks = node.tracks.filter((t) => !S.sel.has(t)); await api("node/tracks", { id: node.id, tracks: node.tracks }); S.sel.clear(); emit("nodes");
});
const removeFromLibrary = safe(async () => {
  const n = S.sel.size; if (!n) return;
  if (!await confirmSheet(`Remove ${n} track${n > 1 ? "s" : ""} from the library?`, "They come off every playlist. The files stay on your drive.", "Remove", true)) return;
  await api("remove", { ids: [...S.sel] }); S.sel.clear(); await loadTracks(); await loadNodes();
});

// ---- keyboard: moving through the list; returns true when the key was used
export function key(e) {
  if ((e.key === "ArrowDown" || e.key === "ArrowUp") && S.list.length) {
    const i = Math.max(0, Math.min(S.list.length - 1, (S.anchor ?? -1) + (e.key === "ArrowDown" ? 1 : -1)));
    S.sel = new Set([S.list[i].t.id]); S.anchor = i;
    const sc = $("#scroller");
    if (sc) { if (i * ROW < sc.scrollTop) sc.scrollTop = i * ROW; else if ((i + 1) * ROW > sc.scrollTop + sc.clientHeight) sc.scrollTop = (i + 1) * ROW - sc.clientHeight; }
    renderRows(); return true;
  }
  if (e.key === "Enter" && S.sel.size) { emit("open", { id: [...S.sel][0] }); return true; }
  if (e.key === "Delete" && S.sel.size) { S.view.kind === "node" ? removeFromPlaylist() : removeFromLibrary(); return true; }
  if (e.key === "a" && e.ctrlKey) { S.sel = new Set(S.list.map((x) => x.t.id)); renderRows(); return true; }
  return false;
}
export const firstSelected = () => (S.sel.size ? [...S.sel][0] : null);

export function init() {
  on("tracks", () => { cache.clear(); refresh(); });
  on("nodes", refresh);
  on("thumbs", () => { cache.clear(); renderRows(); });
  on("view", ({ rebuild } = {}) => { if (rebuild) mount($("#listPanel")); refresh(); });
  on("preview", renderRows);
}
export function search(q) { S.query = q; const sc = $("#scroller"); if (sc) sc.scrollTop = 0; refresh(); }
export const relayout = () => { renderCols(); renderRows(); };
