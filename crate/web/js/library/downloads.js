// Downloads (Labs): search Soulseek through slskd, download the best copy, and use it
// straight away. Finished files are imported and analysed by themselves; right-click one
// to load it or add it to a playlist.
import { h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { emit } from "../core/bus.js";
import { menu } from "../core/ui.js";
import { fmtTime } from "../core/format.js";
import { S, loadTracks, setView } from "../state.js";
import { addToPlaylist } from "./addto.js";

const D = { q: "", sid: null, groups: [], done: true, transfers: [], status: null, error: null, timer: null, seen: new Set() };
const mb = (b) => `${(b / 1048576).toFixed(b < 1e8 ? 1 : 0)} MB`;
const speed = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
const here = () => S.view.kind === "downloads";

// open the tab with a search already running (the wishlist's "Soulseek" button)
export function searchFor(q) { D.q = q; setView({ kind: "downloads" }); search(q); }

const search = safe(async (q) => {
  q = (q || "").trim(); if (!q) return;
  D.q = q; D.groups = []; D.done = false; D.error = null;
  D.sid = (await api("slsk/search", { q })).id;
  draw(); tick();
});

const download = safe(async (src) => {
  await api("slsk/download", { user: src.user, filename: src.filename, size: src.size });
  toast(`Downloading ${src.name} from ${src.user}`); tick();
});

// one poll loop for both the search and the queue, while the tab is open
function tick() {
  clearTimeout(D.timer);
  D.timer = setTimeout(async () => {
    if (!here()) return;
    try {
      if (D.sid && !D.done) { const r = await api(`slsk-results/${D.sid}`); D.groups = r.groups; D.done = r.done; }
      D.transfers = await api("slsk-downloads");
      // anything newly in the library: refresh the collection so it's playable everywhere
      const fresh = D.transfers.filter((t) => t.track_id && t.analysed && !D.seen.has(t.track_id));
      if (fresh.length) { fresh.forEach((t) => D.seen.add(t.track_id)); await loadTracks(); }
      D.error = null;
    } catch (e) { D.error = e.message; }
    draw();
    const busy = (D.sid && !D.done) || D.transfers.some((t) => !t.state.startsWith("Completed") || (t.track_id && !t.analysed) || (t.state === "Completed, Succeeded" && !t.track_id));
    if (here()) D.timer = setTimeout(tick, busy ? 1000 : 5000);
  }, 50);
}

let panelRef = null;
export async function renderDownloads(panel) {
  panelRef = panel;
  try { D.status = await api("slsk"); D.error = null; } catch (e) { D.status = null; D.error = e.message; }
  draw(); tick();
}

function draw() {
  if (!panelRef || !here()) return;
  const st = D.status;
  const sub = st ? (st.logged_in ? `Soulseek, signed in as ${st.user}` : "slskd is running but not signed in to Soulseek") : "";
  const input = h("input", { class: "field", value: D.q, placeholder: "Artist and track, e.g. Fisher Losing It", style: "flex:1", onkeydown: (e) => e.key === "Enter" && search(e.target.value) });
  const cards = [h("div", { class: "card" }, h("div", { class: "row" }, icon("i-search"), input,
    h("button", { class: "btn primary sm", onclick: () => search(input.value) }, "Search")))];
  if (D.error && !st) cards.push(h("div", { class: "empty", style: "position:static;padding:40px" }, h("strong", {}, "Crate can't reach slskd"),
    h("p", {}, `${D.error}. Start slskd on this computer, then check its address and API key in Settings, under Labs.`)));
  if (D.transfers.length) cards.push(queue());
  if (D.sid) cards.push(results());
  mount(panelRef, h("div", { class: "listhead" }, h("h2", {}, "Downloads"), h("span", { class: "sub" }, sub), h("div", { class: "spacer" }),
    h("span", { class: "tag" }, "Labs")), h("div", { class: "pane dl" }, ...cards));
  if (document.activeElement === document.body) input.focus();
}

function results() {
  const queued = new Set(D.transfers.map((t) => t.filename));
  const rows = D.groups.map((g) => {
    const b = g.best, got = queued.has(b.filename);
    return h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "ttl" }, g.title), h("div", { class: "t3" }, `${b.user}${b.free ? "" : `, queue ${b.queue}`}, ${speed(b.speed)}${g.count > 1 ? `, ${g.count} sharers` : ""}`)),
      h("span", { class: "tag" + (b.lossless ? " good" : "") }, b.quality),
      h("span", { class: "t3 num", style: "width:44px" }, b.length ? fmtTime(b.length) : ""),
      h("span", { class: "t3 num", style: "width:60px" }, mb(b.size)),
      h("span", { class: "dot", title: b.free ? "Free upload slot: starts now" : "Busy: you'll wait in a queue", style: `background:${b.free ? "var(--ok)" : "var(--text3)"}` }),
      g.count > 1 ? h("button", { class: "btn sm ghost", "data-help": "<b>Other copies</b>  The same track from other sharers, best first",
        onclick: (e) => menu(e, g.sources.map((s) => ({ label: `${s.quality}, ${mb(s.size)}, ${s.user}${s.free ? "" : " (queued)"}`, run: () => download(s) }))) }, `${g.count - 1} more`) : null,
      h("button", { class: "btn sm" + (got ? "" : " primary"), disabled: got, onclick: () => download(b) }, got ? "Queued" : "Download"));
  });
  const head = h("div", { class: "row t3" }, D.done ? `${D.groups.length} tracks for "${D.q}", best copies first` : `Searching for "${D.q}"…`);
  return h("div", { class: "card" }, head, ...rows, D.done && !rows.length ? h("div", { class: "row t3" }, "Nothing found. Try fewer words, or just the artist") : null);
}

function queue() {
  const rows = D.transfers.slice().reverse().map((t) => {
    const name = t.filename.split(/[\\/]/).pop(), track = t.track_id ? S.byId.get(t.track_id) : null;
    const ok = t.state === "Completed, Succeeded", failed = t.state.startsWith("Completed") && !ok;
    const state = track ? (t.analysed ? "In your library" : "Analysing") : ok ? "Importing" : failed ? t.state.split(", ")[1] || "Failed" : t.state.startsWith("Queued") ? "Queued by sharer" : t.state === "InProgress" ? `${t.percent}%, ${speed(t.speed)}` : t.state;
    const row = h("div", { class: "row" + (track ? " lib" : ""), title: track ? "Right-click for options. Double-click to load" : "",
      oncontextmenu: (e) => { if (!track) return; e.preventDefault(); trackMenu(e, track); },
      ondblclick: () => track && emit("open", { id: track.id }) },
      icon(track ? "i-check" : failed ? "i-warn" : "i-down", "i sm"),
      h("div", { class: "grow" }, h("div", { class: "ttl" }, track ? `${track.artist ? `${track.artist} - ` : ""}${track.title}` : name), h("div", { class: "t3" }, t.user)),
      track && t.analysed ? h("span", { class: "t3 num" }, `${track.bpm ? track.bpm.toFixed(0) : ""} ${track.camelot || ""}`) : null,
      h("span", { class: "dlstate" + (failed ? " bad" : "") }, state),
      !ok && !failed ? h("span", { class: "dlbar" }, h("b", { style: `width:${t.percent}%` })) : null);
    return row;
  });
  return h("div", { class: "card" }, h("div", { class: "row t3" }, "Downloads. Finished tracks go straight into your library"), ...rows);
}

function trackMenu(e, t) {
  menu(e, [
    { label: "Load", icon: "i-play", run: () => emit("open", { id: t.id }) },
    addToPlaylist([t.id]),
    { label: "Show in Explorer", icon: "i-reveal", run: safe(() => api("reveal", { id: t.id })) },
  ]);
}
