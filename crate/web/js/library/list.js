// The track list: columns that stretch to fit, filtering, sorting, selection, and a
// virtualised body that reuses row elements, so scrolling never rebuilds them.
import { $, $$, h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { emit, on } from "../core/bus.js";
import { confirmSheet, gr, menu, sheet } from "../core/ui.js";
import { pref, setPref } from "../core/prefs.js";
import { artBg, camelotColor, energyBar, fmtChip, fmtTempos, fmtTime, mixesWith, plural, tempoTitle } from "../core/format.js";
import { mini } from "../core/wave.js";
import { S, editTracks, gainFor, loadNodes, loadTracks, nodeById, setNodeTracks } from "../state.js";
import { mode, DECK_LETTERS } from "../mode.js";
import { pollSoon } from "../jobs.js";
import { audio, deck } from "./preview.js";
import { renderDupes, renderWish } from "./views.js";
import { renderDownloads } from "./downloads.js";
import { renderLive } from "./live.js";
import { renderStick } from "./stick.js";
import { addToPlaylist } from "./addto.js";
import { addFolder, findMoved, importRekordbox } from "../sheets/music.js";
import { storeSheet } from "../sheets/store.js";
import { betterSheet } from "../sheets/better.js";
import { buildSetSheet } from "../sheets/setbuilder.js";
import { whatNext } from "../sheets/next.js";

// ---- columns
const COLUMNS = [
  { key: "art", label: "", w: 40, fixed: true, render: (t) => h("span", { class: "thumb", style: artBg(t) }) },
  { key: "pos", label: "#", w: 40, cls: "num t3" },
  { key: "title", label: "Title", w: 240, cls: "ttl", render: (t) => (S.onStick.has(t.id)
    ? h("span", {}, t.title, h("i", { class: "onstick", title: "On a stick that's plugged in" }, icon("i-usb", "i xs"))) : t.title) },
  { key: "artist", label: "Artist", w: 160, cls: "t2" },
  { key: "wave", label: "Waveform", w: 130, render: (t) => (S.thumbs.has(t.id) ? mini(S.thumbs.get(t.id)) : "") },
  { key: "bpm", label: "BPM", w: 88, cls: "num", render: (t) => (!t.analysed && !t.error ? h("span", { class: "pending" }, "Analysing") : !t.bpm ? ""
    : t.tempos ? h("span", { class: "tempos", title: tempoTitle(t.tempos) }, fmtTempos(t.tempos.length > 2 ? t.tempos.slice(0, 2) : t.tempos, "→"), t.tempos.length > 2 ? h("i", {}, `+${t.tempos.length - 2}`) : null)
    : t.variable ? h("span", { title: "Played live: the tempo drifts, and the grid follows it" }, `~${Math.round(t.bpm)}`)
    : t.bpm.toFixed(t.bpm % 1 ? 2 : 0)) },
  { key: "camelot", label: "Key", w: 62, render: (t) => (t.camelot ? h("span", { class: "key" + (mixesWith(deck.t, t) ? " match" : ""), style: `--kc:${camelotColor(t.camelot)}`, title: t.key }, t.camelot) : t.key || "") },
  { key: "energy", label: "Energy", w: 76, render: (t) => energyBar(t.energy) },
  { key: "duration", label: "Time", w: 58, cls: "num t2", render: (t) => fmtTime(t.duration) },
  { key: "lufs", label: "LUFS", w: 60, cls: "num t2", render: (t) => (t.lufs == null ? (t.error || t.analysed ? "" : "…")
    : loudness.median != null && Math.abs(t.lufs - loudness.median) > LOUD_SPREAD
      ? h("span", { class: "loud-off", title: `${(t.lufs - loudness.median).toFixed(1)} dB from the rest of this playlist` }, t.lufs.toFixed(1)) : t.lufs.toFixed(1)) },
  { key: "gain", label: "Level", w: 64, cls: "num", render: (t) => { const g = gainFor(t); return g ? h("span", { class: "t2", title: g.cap ? "Boost held back by the true-peak ceiling so nothing clips" : "Gain applied to the copy on export" }, (g.db > 0 ? "+" : "") + g.db.toFixed(1)) : ""; } },
  { key: "genre", label: "Genre", w: 110, cls: "t2" },
  { key: "vibe", label: "Vibe", w: 86, render: (t) => (t.vibe ? h("span", { class: `vibe v-${VIBES.indexOf(t.vibe)}` }, t.vibe) : "") },
  { key: "label", label: "Label", w: 110, cls: "t2" },
  { key: "format", label: "Format", w: 108, cls: "t3", render: (t) => h("span", {}, fmtChip(t), t.sample_rate ? `${(t.sample_rate / 1000).toFixed(1)}k` : "") },
  { key: "plays", label: "Plays", w: 46, cls: "num t3" },
  { key: "date_added", label: "Added", w: 92, cls: "t3", render: (t) => shortDate(t.date_added) },
  { key: "issues", label: "", w: 36, fixed: true, render: (t) => (t.issues && t.issues.length ? h("span", { class: "flag", title: t.issues.join("\n") }, icon("i-warn", "i sm")) : "") },
];
// in a playlist, tracks far louder or quieter than the rest are flagged in the LUFS column
const LOUD_SPREAD = 3, loudness = { median: null };
const VIBES = ["Warm-up", "Build", "Peak", "Closing", "After hours"];
// "6 Nov" this year, "6 Nov 2025" before it
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], THIS_YEAR = new Date().getFullYear();
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || ""); if (!m) return "";
  return `${+m[3]} ${MONTHS[+m[2] - 1]}${+m[1] === THIS_YEAR ? "" : ` ${m[1]}`}`;
}
const PROBLEM = { key: "problem", label: "Problem", w: 480, render: (t) => h("span", { class: "problem", title: (t.issues || []).join("\n") }, (t.issues || []).join("  ·  ")) };
const STRETCH = { title: 4, artist: 3, problem: 4, genre: 1.2, label: 1.2 }, MIN_W = { title: 170, artist: 110, problem: 240 };

// your column order (drag a heading); columns you've never moved keep their place
function ordered() {
  if (!S.colOrder.length) return COLUMNS;
  const rank = (c) => (c.fixed ? (COLUMNS.indexOf(c) ? 1e4 : -1) : S.colOrder.includes(c.key) ? S.colOrder.indexOf(c.key) : 1e3 + COLUMNS.indexOf(c));
  return [...COLUMNS].sort((a, b) => rank(a) - rank(b));
}
function visibleCols() {
  const cols = ordered().filter((c) => !S.hidden.has(c.key));
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
    else if ((m = /^vibe:([\w-]+)$/.exec(tok))) f.vibe = m[1];
    else f.text.push(tok);
  }
  return f;
}
function viewIds() {
  if (S.view.kind === "node") return (nodeById(S.view.id) || { tracks: [] }).tracks;
  if (S.view.kind === "issues") return S.rows.filter((t) => t.issues && t.issues.length).map((t) => t.id);
  if (S.view.kind === "recent") return S.rows.filter((t) => t.last_played).sort((a, b) => b.last_played.localeCompare(a.last_played)).slice(0, RECENT).map((t) => t.id);
  if (S.view.kind === "quiet") {  // played before, not in the last six months
    const cut = new Date(Date.now() - QUIET_DAYS * 864e5).toISOString();
    return S.rows.filter((t) => t.last_played && t.last_played < cut).sort((a, b) => a.last_played.localeCompare(b.last_played)).map((t) => t.id);
  }
  return S.rows.map((t) => t.id);
}
const RECENT = 300, QUIET_DAYS = 182;
function viewTitle() {
  const v = S.view;
  if (v.kind === "all") return ["Collection", `${S.rows.length} tracks`];
  if (v.kind === "issues") return ["Issues", "Tracks worth fixing before they reach a club system"];
  if (v.kind === "recent") return ["Recently played", "From your CDJs and Perform, newest first"];
  if (v.kind === "quiet") return ["Not played lately", "Tracks you've played before, but not in six months"];
  if (v.kind === "search") return [v.name, v.q];
  const n = nodeById(v.id);
  return n ? [n.name, `${n.rules ? "Smart playlist, " : ""}${playlistStats(n.tracks)}`] : ["", ""];
}
// the Issues view as a health check: each kind of problem with the one click that fixes it
function healthActions() {
  const has = (p) => S.rows.filter((t) => t.issues?.some((x) => x.startsWith(p))).length;
  const missing = has("File not found"), failed = S.rows.filter((t) => t.error).length, waiting = S.rows.filter((t) => !t.analysed).length;
  const btn = (label, n, run, help) => (n ? h("button", { class: "btn sm", "data-help": help, onclick: run }, `${label} (${n})`) : null);
  return [
    btn("Find moved files", missing, findMoved, "<b>Find moved files</b>  Reconnects tracks whose files moved, with their cues and grids"),
    btn("Analyse waiting", waiting, safe(async () => { await api("analyse", { ids: S.rows.filter((t) => !t.analysed).map((t) => t.id) }); pollSoon(); }), "<b>Analyse</b>  Tracks not analysed yet"),
    btn("Try failed again", failed, safe(async () => { await api("analyse", { ids: S.rows.filter((t) => t.error).map((t) => t.id), fresh: true }); pollSoon(); }), "<b>Analyse again</b>  Tracks that couldn't be read last time"),
  ].filter(Boolean);
}

// "24 tracks, 1 h 52 min, 122-128 BPM, start to end": how long the set runs and where it goes
function playlistStats(ids) {
  const ts = ids.map((id) => S.byId.get(id)).filter(Boolean), secs = ts.reduce((s, t) => s + (t.duration || 0), 0);
  const bpms = ts.map((t) => t.bpm).filter(Boolean), hrs = Math.floor(secs / 3600), mins = Math.round((secs % 3600) / 60);
  const len = secs ? `, ${hrs ? `${hrs} h ` : ""}${mins} min` : "";
  const range = bpms.length ? `, ${Math.round(Math.min(...bpms))}-${Math.round(Math.max(...bpms))} BPM` : "";
  const arc = bpms.length > 1 ? ` (${Math.round(bpms[0])} → ${Math.round(bpms.at(-1))})` : "";
  return `${plural(ts.length, "track")}${len}${range}${arc}`;
}
export function refresh() {
  const panel = $("#listPanel");
  if (S.view.kind === "dupes") return renderDupes(panel);
  if (S.view.kind === "wish") return renderWish(panel);
  if (S.view.kind === "downloads") return renderDownloads(panel);
  if (S.view.kind === "live") return renderLive(panel);
  if (S.view.kind === "stick") return renderStick(panel);
  if (!$("#rows")) build(panel);
  const [title, sub] = viewTitle();
  $("#lhTitle").textContent = title; $("#lhSub").textContent = sub;
  mount($("#lhActions"), ...(S.view.kind === "issues" ? healthActions() : []));
  const f = parseQuery(S.view.kind === "search" ? `${S.view.q} ${S.query}` : S.query);
  let list = viewIds().map((id, i) => ({ t: S.byId.get(id), pos: i + 1 })).filter((x) => x.t);
  const lufs = S.view.kind === "node" ? list.map(({ t }) => t.lufs).filter((x) => x != null).sort((a, b) => a - b) : [];
  loudness.median = lufs.length > 2 ? lufs[lufs.length >> 1] : null;
  if (f.text.length) list = list.filter(({ t }) => { const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.label} ${t.remixer} ${t.comment}`.toLowerCase(); return f.text.every((w) => hay.includes(w)); });
  if (f.bpm) {  // a track that changes tempo matches on any of its tempos
    const inRange = (b) => b >= f.bpm[0] - 0.005 && b <= f.bpm[1] + 0.005;
    list = list.filter(({ t }) => (t.tempos ? t.tempos.some((x) => inRange(x.bpm)) : inRange(t.bpm)));
  }
  if (f.key) list = list.filter(({ t }) => t.camelot === f.key);
  if (f.energy) list = list.filter(({ t }) => t.energy >= f.energy[0] && t.energy <= f.energy[1]);
  if (f.vibe) list = list.filter(({ t }) => (t.vibe || "").toLowerCase().startsWith(f.vibe));
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
    await setNodeTracks(node, rest, "reorder");
  }));
}

function renderCols() {
  const el = $("#cols"); if (!el) return;
  layout();
  const isNode = S.view.kind === "node";
  mount(el, ...cols.map((c) => {
    const cell = h("div", { class: `c-${c.key}${(c.cls || "").includes("num") ? " num" : ""}`, style: `width:${widths.get(c.key)}px` }, c.key === "pos" && !isNode ? "#" : c.label);
    if (S.sort.key === c.key) { cell.classList.add("on"); cell.append(h("span", { class: "arr" }, S.sort.dir > 0 ? "↑" : "↓")); }
    if (c.label) cell.onclick = () => { S.sort = { key: c.key, dir: S.sort.key === c.key ? -S.sort.dir : 1 }; refresh(); };
    if (!c.fixed) {
      cell.append(grip(c));
      cell.draggable = true;
      cell.ondragstart = (e) => { e.dataTransfer.setData("text/crate-col", c.key); };
      cell.ondragover = (e) => { if (e.dataTransfer.types.includes("text/crate-col")) e.preventDefault(); };
      cell.ondrop = (e) => { e.preventDefault(); moveCol(e.dataTransfer.getData("text/crate-col"), c.key); };
    }
    return cell;
  }));
}
function moveCol(key, before) {
  if (!key || key === before) return;
  const order = ordered().filter((c) => !c.fixed).map((c) => c.key).filter((k) => k !== key);
  order.splice(order.indexOf(before), 0, key);
  S.colOrder = order; setPref("colOrder", order); cache.clear(); relayout();
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
  r = h("div", { draggable: "true" }, ...cols.map((c) => h("div", { class: `c-${c.key} ${c.cls || ""}`, style: `width:${widths.get(c.key)}px` }, c.key === "pos" ? "" : c.render ? c.render(t) : t[c.key] ?? "")));
  r.posCell = r.children[cols.findIndex((c) => c.key === "pos")] || null;
  r.missing = !!(t.issues && t.issues.some((x) => x.startsWith("File not found")));
  cache.set(t.id, r);
  return r;
}
export function renderRows() {
  const sc = $("#scroller"), rows = $("#rows"); if (!rows) return;
  layout();
  const key = `${cols.map((c) => `${c.key}:${widths.get(c.key)}`).join()}|${ROW}|${loudness.median}`, mk = `${deck.id}|${deck.t?.camelot}|${deck.t?.bpm}`;
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
  if (!S.rows.length) return h("div", { class: "empty welcome" }, icon("logo", "logo"), h("strong", {}, "Three steps to your first stick"),
    h("ol", { class: "steps" },
      h("li", {}, h("b", {}, "Bring your music in"), h("span", {}, "A folder you keep music in, or your whole rekordbox collection with its cues and playlists."),
        h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: addFolder }, icon("i-plus"), "Add music folder"), h("button", { class: "btn", onclick: importRekordbox }, icon("i-import"), "Import from rekordbox"))),
      h("li", {}, h("b", {}, "Let Crate listen"), h("span", {}, "Tempo, beat grid, key, cue points, loudness and sound quality, on every core. Nothing to press.")),
      h("li", {}, h("b", {}, "Plug in a stick"), h("span", {}, "Export to USB puts your playlists on it, ready for CDJs."))));
  const searching = !!S.query.trim();
  const [strong, p] = searching ? ["No matches", "Nothing here fits that search."]
    : S.view.kind === "issues" ? ["No issues", "Every track is where it should be, analysed, and sounds right."]
    : S.view.kind === "recent" ? ["Nothing played yet", "Tracks you play in Perform, or on CDJs with Live on, show up here."]
    : S.view.kind === "quiet" ? ["Nothing gone quiet", "Everything you've played has been played in the last six months."]
    : S.view.kind === "node" ? ((nodeById(S.view.id) || {}).rules ? ["Nothing matches yet", "Edit the rules from the playlist's menu, or add more music."] : ["Empty playlist", "Drag tracks from Collection onto this playlist."])
      : ["No matches", "Try a different search."];
  return h("div", { class: "empty" }, h("strong", {}, strong), h("p", {}, p),
    searching ? h("button", { class: "btn sm", onclick: () => { $("#q").value = ""; search(""); } }, "Clear search") : null);
}

// ---- actions on tracks
const selection = (t) => (S.sel.size ? [...S.sel] : [t.id]);
function trackMenu(e, t) {
  const ids = selection(t), node = S.view.kind === "node" ? nodeById(S.view.id) : null;
  menu(e, [
    ...(mode.perform
      ? DECK_LETTERS.slice(0, mode.decks).map((k, i) => ({ label: `Load to deck ${k}`, icon: "i-deck", kbd: i < 2 ? `Shift+${i ? "Right" : "Left"}` : "", run: () => emit("open", { id: t.id, deck: k }) }))
      : [{ label: "Load", icon: "i-play", kbd: "Enter", run: () => emit("open", { id: t.id }) }]),
    { label: "What next?", icon: "i-chev", run: () => whatNext(t) },
    { label: "Build a set from here", icon: "i-set", run: () => buildSetSheet(t.id) },
    addToPlaylist(ids),
    "-",
    S.settings?.labs_soulseek === "1" && ids.length === 1 ? { label: "Find better version", icon: "i-down", run: () => betterSheet(t) } : null,
    t.issues && t.issues.length ? { label: "Find a better copy", icon: "i-store", run: () => storeSheet(t) } : null,
    t.issues?.some((x) => x.startsWith("File not found")) ? { label: "Find moved files…", icon: "i-search", run: findMoved } : null,
    { label: "Search the stores", icon: "i-store", run: () => storeSheet(t) },
    { label: "Add to wishlist", icon: "i-heart", run: safe(async () => { await api("wish", { artist: t.artist, title: t.title, track_id: t.id }); toast(`${t.title} is on your wishlist`); }) },
    { label: "Show in Explorer", icon: "i-reveal", run: safe(() => api("reveal", { id: t.id })) },
    ids.some((i) => !S.byId.get(i)?.has_art) ? { label: "Find artwork", icon: "i-search", run: safe(async () => { await api("art/find", { ids }); pollSoon(); }) } : null,
    "-",
    { label: ids.length > 1 ? `Re-analyse ${ids.length} tracks` : "Re-analyse", icon: "i-wave", run: safe(async () => {
      await api("analyse", { ids, fresh: true }); pollSoon();
      toast(`Re-analysing ${ids.length > 1 ? `${ids.length} tracks` : t.title}: tempo, beat grid, key and loudness from scratch. Cues are kept`);
    }) },
    { label: ids.length > 1 ? `Auto cues for ${ids.length} tracks` : "Auto cues", icon: "i-cue", run: () => autoCues(ids) },
    { label: ids.length > 1 ? `Edit ${ids.length} tracks…` : "Edit…", icon: "i-gear", run: () => editSheet(ids) },
    { label: "Vibe", icon: "i-set", sub: [...VIBES, null].map((v) => ({ label: v || "None", run: safe(() => editTracks(ids, { vibe: v }, v ? `vibe ${v}` : "clear vibe")) })) },
    node && !node.rules ? { label: "Remove from playlist", kbd: "Del", run: removeFromPlaylist } : null,
    { label: ids.length > 1 ? `Remove ${ids.length} from library` : "Remove from library", danger: true, run: removeFromLibrary },
  ]);
}
// the same fields on every selected track; anything left blank stays as it is
const editSheet = safe(async (ids) => {
  const one = ids.length === 1 ? S.byId.get(ids[0]) : null;
  const f = (k, label) => [k, label, h("input", { class: "field", value: one?.[k] ?? "", placeholder: one ? "" : "Leave as it is" })];
  const fields = [f("genre", "Genre"), f("label", "Label"), f("comment", "Comment"), f("year", "Year")];
  const vibe = h("select", {}, h("option", { value: "" }, one ? "None" : "Leave as it is"), ...VIBES.map((v) => h("option", { value: v, selected: one?.vibe === v }, v)));
  const rating = h("select", {}, h("option", { value: "" }, one ? "None" : "Leave as it is"), ...[1, 2, 3, 4, 5].map((r) => h("option", { value: r, selected: one?.rating === r }, "★".repeat(r))));
  const ok = await sheet({ title: one ? `Edit ${one.title}` : `Edit ${ids.length} tracks`, width: 460,
    body: [h("div", { class: "group" }, ...fields.map(([, label, el]) => gr(label, "", el)), gr("Vibe", "", vibe), gr("Rating", "", rating))],
    actions: [{ label: "Cancel", result: false }, { label: "Save", default: true, value: () => true }] });
  if (!ok) return;
  const out = {};
  for (const [k, , el] of fields) if (one ? el.value !== String(one[k] ?? "") : el.value.trim()) out[k] = k === "year" ? +el.value || null : el.value.trim();
  if (one ? vibe.value !== (one.vibe || "") : vibe.value) out.vibe = vibe.value || null;
  if (one ? rating.value !== String(one.rating || "") : rating.value) out.rating = +rating.value || 0;
  if (Object.keys(out).length) { await editTracks(ids, out, `edit ${ids.length > 1 ? `${ids.length} tracks` : one.title}`); toast("Saved. Ctrl+Z undoes it"); }
});

// cue points from each track's sections: Intro, Build, Drop, Breakdown... on pads A-H in order
const autoCues = safe(async (ids) => {
  let { placed } = await api("autocues", { ids });
  const kept = ids.length - placed;
  if (kept && await confirmSheet(ids.length > 1 ? `${kept} of these have cues you set` : "This track has cues you set",
    "Replace them with Crate's cue points from the song's sections? This can't be undone.", "Replace them", true)) {
    ({ placed } = await api("autocues", { ids, mine_too: true }));
  }
  if (ids.includes(deck.id)) emit("open", { id: deck.id });
  toast(placed ? `Cue points placed on ${placed > 1 ? `${placed} tracks` : "the track"}` : "No cue points placed");
});

const removeFromPlaylist = safe(async () => {
  const node = nodeById(S.view.id); if (!node || node.rules) return;
  await setNodeTracks(node, node.tracks.filter((t) => !S.sel.has(t)), `remove from ${node.name}`); S.sel.clear();
});
const removeFromLibrary = safe(async () => {
  const n = S.sel.size; if (!n) return;
  if (!await confirmSheet(`Remove ${n} track${n > 1 ? "s" : ""} from the library?`, "They come off every playlist. The files stay on your drive.", "Remove", true)) return;
  await api("remove", { ids: [...S.sel] }); S.sel.clear(); await loadTracks(); await loadNodes();
});

// ---- keyboard: moving through the list; returns true when the key was used
// type-to-jump: with the list last clicked, typing jumps to the first title that starts that way
let typed = "", typedAt = 0, listFocus = false;
addEventListener("pointerdown", (e) => { listFocus = !!e.target.closest?.("#listPanel"); }, true);
export function jump(e) {
  if (!listFocus || e.ctrlKey || e.altKey || e.metaKey || e.key.length !== 1 || e.key === " " || !S.list.length) return false;
  const now = performance.now();
  typed = (now - typedAt < 900 ? typed : "") + e.key.toLowerCase(); typedAt = now;
  const i = S.list.findIndex(({ t }) => (t.title || "").toLowerCase().startsWith(typed));
  const at = i >= 0 ? i : S.list.findIndex(({ t }) => `${t.artist} ${t.title}`.toLowerCase().startsWith(typed));
  if (at < 0) return true;
  S.sel = new Set([S.list[at].t.id]); S.anchor = at;
  const sc = $("#scroller"); if (sc) sc.scrollTop = Math.max(0, at * ROW - sc.clientHeight / 3);
  renderRows(); return true;
}

export function selectAll() { S.sel = new Set(S.list.map((x) => x.t.id)); renderRows(); }

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
  if (e.key === "a" && e.ctrlKey) { selectAll(); return true; }
  return false;
}
export const firstSelected = () => (S.sel.size ? [...S.sel][0] : null);

export function init() {
  on("tracks", () => { cache.clear(); refresh(); });
  on("nodes", refresh);
  for (const ev of ["thumbs", "onstick"]) on(ev, () => { cache.clear(); renderRows(); });
  on("view", ({ rebuild } = {}) => { if (rebuild) mount($("#listPanel")); refresh(); });
  on("preview", renderRows);
}
export function search(q) { S.query = q; const sc = $("#scroller"); if (sc) sc.scrollTop = 0; refresh(); }
export const relayout = () => { renderCols(); renderRows(); };
