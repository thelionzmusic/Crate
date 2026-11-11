// Downloads (Labs): search Soulseek through slskd, download the best copy, and use it
// straight away. Finished files are imported and analysed by themselves; right-click one
// to load it or add it to a playlist.
import { h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { emit } from "../core/bus.js";
import { menu, sheet } from "../core/ui.js";
import { fmtTime } from "../core/format.js";
import { S, loadTracks, setView } from "../state.js";
import { addToPlaylist, pickPlaylist } from "./addto.js";

const D = { q: "", sid: null, groups: [], done: true, transfers: [], status: null, error: null, timer: null, seen: new Set(), batch: null,
  open: new Set(), from: new Map(), tried: new Set() };  // expanded tracks; filename -> its group; versions already attempted
const mb = (b) => `${(b / 1048576).toFixed(b < 1e8 ? 1 : 0)} MB`;
const speed = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
const here = () => S.view.kind === "downloads";
const key = (x) => `${x.user}|${x.filename}`;  // the same path can be shared by several people

// open the tab with a search already running (the wishlist's "Soulseek" button)
export function searchFor(q) { D.q = q; setView({ kind: "downloads" }); search(q); }

const search = safe(async (q) => {
  q = (q || "").trim(); if (!q) return;
  D.q = q; D.groups = []; D.done = false; D.error = null;
  D.sid = (await api("slsk/search", { q })).id;
  draw(); tick();
});

// playlist: file the track there once it's downloaded and analysed
const download = safe(async (src, group, playlist) => {
  await api("slsk/download", { user: src.user, filename: src.filename, size: src.size, playlist: playlist?.id });
  if (group) D.from.set(key(src), group);
  D.tried.add(key(src));
  toast(playlist ? `Downloading ${src.name}. It joins ${playlist.name} once it's analysed` : `Downloading ${src.name} from ${src.user}`); tick();
});
const nextVersion = (g) => g && g.sources.find((s) => !D.tried.has(key(s)));

// one poll loop for both the search and the queue, while the tab is open
function tick() {
  clearTimeout(D.timer);
  D.timer = setTimeout(async () => {
    if (!here()) return;
    try {
      if (D.sid && !D.done) { const r = await api(`slsk-results/${D.sid}`); D.groups = r.groups; D.done = r.done; }
      D.transfers = await api("slsk-downloads");
      const b = await api("slsk-batch"), before = D.batch?.done ?? 0;
      D.batch = b && b.items ? b : null;
      if (D.batch && D.batch.done > before) { const { loadNodes } = await import("../state.js"); await loadNodes(); }  // playlist counts
      // anything newly in the library: refresh the collection so it's playable everywhere
      const fresh = D.transfers.filter((t) => t.track_id && t.analysed && !D.seen.has(t.track_id));
      if (fresh.length) { fresh.forEach((t) => D.seen.add(t.track_id)); await loadTracks(); }
      D.error = null;
    } catch (e) { D.error = e.message; }
    draw();
    const busy = (D.sid && !D.done) || D.batch?.running || D.transfers.some((t) => !t.state.startsWith("Completed") || (t.track_id && !t.analysed) || (t.state === "Completed, Succeeded" && !t.track_id));
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
  const sub = st && st.state === "running" ? (st.logged_in ? `Soulseek, signed in as ${st.user}` : st.connecting ? "Signing in to Soulseek…" : "Not signed in to Soulseek") : "";
  const input = h("input", { class: "field", value: D.q, placeholder: "Artist and track, e.g. Fisher Losing It", style: "flex:1", onkeydown: (e) => e.key === "Enter" && search(e.target.value) });
  const notReady = !st || st.state !== "running";
  const cards = notReady ? [] : [h("div", { class: "card" }, h("div", { class: "row" }, icon("i-search"), input,
    h("button", { class: "btn primary sm", onclick: () => search(input.value) }, "Search")))];
  if (notReady) {
    const [title, text] = !st ? ["Crate can't reach Soulseek", D.error || ""]
      : st.state === "installing" ? ["Setting up Soulseek", `Getting slskd, the Soulseek client: ${Math.round((st.progress || 0) * 100)}%. This happens once.`]
      : st.state === "starting" ? ["Starting Soulseek", "A few seconds…"]
      : st.state === "error" ? ["Soulseek isn't working", st.error]
      : ["Sign in to Soulseek", "Add your Soulseek username and password in Settings, under Labs. Crate runs the rest."];
    cards.push(h("div", { class: "empty", style: "position:static;padding:40px" }, h("strong", {}, title), h("p", {}, text)));
    if (st && ["installing", "starting"].includes(st.state)) setTimeout(() => here() && renderDownloads(panelRef), 1000);
  }
  if (D.batch) cards.push(batchCard());
  if (D.transfers.length) cards.push(queue());
  if (D.sid) cards.push(results());
  mount(panelRef, h("div", { class: "listhead" }, h("h2", {}, "Downloads"), h("span", { class: "sub" }, sub), h("div", { class: "spacer" }),
    h("button", { class: "btn sm", "data-help": "<b>Import CSV</b>  A list of tracks (artist and title columns, a Spotify export, or one search per line). Crate finds and downloads each one",
      onclick: () => csvInput.click() }, icon("i-import", "i sm"), "Import CSV"),
    h("span", { class: "tag" }, "Labs")), h("div", { class: "pane dl" }, ...cards));
  if (!notReady && document.activeElement === document.body) input.focus();
}

function results() {
  const failed = (t) => t.state.startsWith("Completed") && t.state !== "Completed, Succeeded";
  const queued = new Set(D.transfers.filter((t) => !failed(t)).map(key));
  const buttons = (src, g, primary) => {
    const got = queued.has(key(src));
    return [
      h("button", { class: "btn sm", disabled: got, "data-help": "<b>Add to playlist</b>  Download it, and once it's analysed it's in the playlist, ready to play",
        onclick: (e) => pickPlaylist(e, (n) => download(src, g, n)) }, icon("i-list", "i sm"), "Playlist"),
      h("button", { class: "btn sm" + (primary && !got ? " primary" : ""), disabled: got, onclick: () => download(src, g) }, got ? "Queued" : "Download"),
    ];
  };
  const facts = (src) => [
    h("span", { class: "tag" + (src.lossless ? " good" : "") }, src.quality),
    h("span", { class: "t3 num", style: "width:44px" }, src.length ? fmtTime(src.length) : ""),
    h("span", { class: "t3 num", style: "width:60px" }, mb(src.size)),
    h("span", { class: "dot", title: src.free ? "Free upload slot: starts now" : `Busy: you'd be number ${src.queue + 1} in the queue`, style: `background:${src.free ? "var(--ok)" : "var(--text3)"}` }),
  ];
  const rows = D.groups.flatMap((g) => {
    const b = g.best, open = D.open.has(g.key);
    const toggle = g.count > 1 ? h("button", { class: "btn sm ghost", "aria-expanded": open, "data-help": "<b>Versions</b>  Every copy of this track, best first",
      onclick: () => { open ? D.open.delete(g.key) : D.open.add(g.key); draw(); } }, `${g.count} versions`, icon("i-chev", "i sm" + (open ? " down" : ""))) : null;
    const main = h("div", { class: "row group" },
      h("div", { class: "grow" }, h("div", { class: "ttl" }, g.title), h("div", { class: "t3" }, `${b.user}${b.free ? "" : `, queue ${b.queue}`}, ${speed(b.speed)}`)),
      ...facts(b), toggle, ...buttons(b, g, true));
    if (!open) return [main];
    // every version, in its own scrolling box
    const list = h("div", { class: "vers" }, ...g.sources.map((src) => h("div", { class: "row" },
      h("div", { class: "grow" }, h("div", { class: "ttl" }, src.name), h("div", { class: "t3" }, `${src.user}${src.free ? "" : `, queue ${src.queue}`}, ${speed(src.speed)}`)),
      ...facts(src), ...buttons(src, g, false))));
    return [main, list];
  });
  const head = h("div", { class: "row t3" }, D.done ? `${D.groups.length} tracks for "${D.q}", best copies first` : `Searching for "${D.q}"…`);
  return h("div", { class: "card" }, head, ...rows, D.done && !rows.length ? h("div", { class: "row t3" }, "Nothing found. Try fewer words, or just the artist") : null);
}

function queue() {
  // a refused copy of a track you then got from someone else isn't worth showing
  const base = (t) => t.filename.split(/[\\/]/).pop().toLowerCase();
  const got = new Set(D.transfers.filter((t) => t.state === "Completed, Succeeded").map(base));
  const shown = D.transfers.filter((t) => !(t.state.startsWith("Completed") && t.state !== "Completed, Succeeded" && got.has(base(t))));
  const rows = shown.slice().reverse().map((t) => {
    const name = t.filename.split(/[\\/]/).pop(), track = t.track_id ? S.byId.get(t.track_id) : null;
    const ok = t.state === "Completed, Succeeded", failed = t.state.startsWith("Completed") && !ok;
    const done = track && t.analysed;
    const state = track ? (done ? (t.playlist ? `In ${t.playlist}` : "In your library") : "Analysing") : ok ? "Importing"
      : failed ? "Download failed" : t.state.startsWith("Queued") ? "Queued by sharer" : t.state === "InProgress" ? `${t.percent}%, ${speed(t.speed)}`
      : t.state === "Requested" || t.state === "Initializing" ? "Asking the sharer…" : t.state;
    const g = D.from.get(key(t)), next = failed && !t.state.includes("Cancelled") ? nextVersion(g) : null;
    const sub = failed ? h("div", { class: "t3 why" }, t.reason || "No reason given", ` (${t.user})`)
      : h("div", { class: "t3" }, t.user, !done && t.playlist ? `, then into ${t.playlist}` : "");
    const row = h("div", { class: "row" + (track ? " lib" : ""), title: track ? "Right-click for options. Double-click to load" : "",
      oncontextmenu: (e) => { if (!track) return; e.preventDefault(); trackMenu(e, track); },
      ondblclick: () => track && emit("open", { id: track.id }) },
      icon(track ? "i-check" : failed ? "i-warn" : "i-down", "i sm"),
      h("div", { class: "grow" }, h("div", { class: "ttl" }, track ? `${track.artist ? `${track.artist} - ` : ""}${track.title}` : name), sub),
      track && t.analysed ? h("span", { class: "t3 num" }, `${track.bpm ? track.bpm.toFixed(0) : ""} ${track.camelot || ""}`) : null,
      next ? h("button", { class: "btn sm", "data-help": `<b>Try another version</b>  ${next.quality} from ${next.user}`, onclick: () => download(next, g) }, "Try another version") : null,
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

// ---- batches from a CSV
const csvInput = Object.assign(document.createElement("input"), { type: "file", accept: ".csv,.txt,text/csv", hidden: true });
document.body.append(csvInput);
csvInput.addEventListener("change", safe(async () => {
  const file = csvInput.files[0]; csvInput.value = "";
  if (!file) return;
  const text = await file.text(), name = file.name.replace(/\.[^.]+$/, "");
  const pre = await api("slsk/batch/preview", { csv: text });
  if (!pre.count) return toast("No tracks found in that file. It needs artist and title columns, or one track per line", 6000);
  const lists = S.nodes.filter((n) => !n.is_folder && !n.rules).sort((a, b) => a.name.localeCompare(b.name));
  const target = h("select", {}, h("option", { value: "new" }, `A new playlist: ${name}`), h("option", { value: "" }, "No playlist, just the library"),
    ...lists.map((n) => h("option", { value: n.id }, n.name)));
  const sample = h("div", { class: "card", style: "margin-top:10px" }, ...pre.sample.map((it) => h("div", { class: "row" },
    h("div", { class: "grow" }, h("div", { class: "ttl" }, it.title), h("div", { class: "t3" }, it.artist || "Search as written")))),
    pre.count > pre.sample.length ? h("div", { class: "row t3" }, `and ${pre.count - pre.sample.length} more`) : null);
  const go = await sheet({ title: `Download ${pre.count} track${pre.count === 1 ? "" : "s"}`, width: 520,
    text: "Crate searches for each one, downloads the best matching copy (trying another if a sharer says no), analyses it, then files it.",
    body: h("div", {}, h("div", { class: "gr" }, h("div", { class: "lbl" }, "Put them in"), target), sample),
    actions: [{ label: "Cancel", result: null }, { label: "Start", default: true, value: () => target.value }] });
  if (go === null || go === undefined) return;
  const r = await api("slsk/batch", { csv: text, name: file.name, playlist: go });
  toast(`Finding ${r.count} tracks. You can leave this tab: downloads carry on`, 5000);
  if (r.playlist) { const { loadNodes } = await import("../state.js"); await loadNodes(); }
  tick();
}));

const STATE = { waiting: "Waiting", searching: "Searching…", downloading: "Downloading", retrying: "Trying another copy", done: "Done",
  "not found": "Not found", failed: "Failed", skipped: "Stopped" };
function batchCard() {
  const b = D.batch;
  const head = h("div", { class: "row" },
    h("div", { class: "grow" }, h("div", { class: "ttl" }, b.name), h("div", { class: "t3" },
      `${b.done} of ${b.total} finished${b.playlist ? `, into ${b.playlist}` : ""}${b.running ? "" : ". Batch over"}`)),
    b.running ? h("span", { class: "dlbar" }, h("b", { style: `width:${(b.done / b.total) * 100}%` })) : null,
    b.running ? h("button", { class: "btn sm", onclick: safe(async () => { await api("slsk/batch/stop", {}); tick(); }) }, "Stop") : null);
  const list = h("div", { class: "vers batch" }, ...b.items.map((it) => {
    const bad = it.state === "failed" || it.state === "not found", ok = it.state === "done";
    return h("div", { class: "row" },
      icon(ok ? "i-check" : bad ? "i-warn" : "i-down", "i sm" + (ok ? " ok" : bad ? " bad" : "")),
      h("div", { class: "grow" }, h("div", { class: "ttl" }, `${it.artist ? `${it.artist} - ` : ""}${it.title}`), it.detail ? h("div", { class: "t3" + (bad ? " why" : "") }, it.detail) : null),
      h("span", { class: "dlstate" + (bad ? " bad" : "") }, STATE[it.state] || it.state));
  }));
  return h("div", { class: "card" }, head, list);
}
