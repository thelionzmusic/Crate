// A USB stick, as the players see it: its playlists on the left, their tracks on the right.
// Playlists and tracks come off with the × or Delete, as in rekordbox's device view; Crate
// rewrites the stick's library and deletes files nothing on it uses any more.
import { $, h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { on } from "../core/bus.js";
import { fmtTime, plural } from "../core/format.js";
import { confirmSheet, menu } from "../core/ui.js";
import { S } from "../state.js";
import { pollSoon } from "../jobs.js";
import { checkStick } from "../sheets/check.js";
import { openExport } from "../sheets/export.js";

const V = { path: null, data: null, list: 0, sel: new Set() };  // list: the playlist shown, 0 = every track
const gb = (b) => `${(b / 1e9).toFixed(b < 1e10 ? 1 : 0)} GB`;

export async function renderStick(panel) {
  const path = S.view.path;
  if (path !== V.path) { V.path = path; V.list = 0; V.data = null; }
  V.sel.clear();
  if (!V.data) mount(panel, head(), h("div", { class: "empty", style: "position:static;padding:60px" }, h("p", {}, "Reading the stick…")));
  try { V.data = await api(`stick?path=${encodeURIComponent(path)}`); } catch (e) { V.data = { error: e.message }; }
  if (S.view.kind !== "stick" || S.view.path !== path) return;  // moved on while it read
  draw(panel);
}

function drive() { return (S.drives || []).find((d) => d.path === V.path) || { label: V.path, path: V.path }; }

function head() {
  const d = V.data, n = d?.tracks?.length;
  const sub = d && !d.error ? `${plural(n, "track")}, ${plural(d.playlists.filter((p) => !p.folder).length, "playlist")}, ${gb(d.free)} free of ${gb(d.total)}` : "";
  return h("div", { class: "listhead" }, h("h2", {}, drive().label), h("span", { class: "sub" }, sub), h("div", { class: "spacer" }),
    h("button", { class: "btn sm", "data-help": "<b>Check</b>  Reads the stick back the way a CDJ does", onclick: () => checkStick(V.path) }, "Check"),
    d && !d.error && !d.managed
      ? h("button", { class: "btn sm primary", "data-help": "<b>Export to it</b>  Replaces what's on the stick with what you pick", onclick: () => openExport({ stick: V.path }) }, icon("i-export", "i sm"), "Export to it")
      : h("button", { class: "btn sm primary", "data-help": "<b>Add playlists</b>  Export more to this stick. What's on it stays", onclick: () => openExport({ stick: V.path }) }, icon("i-export", "i sm"), "Add playlists"));
}

function draw(panel) {
  const d = V.data;
  if (d.error) return mount(panel, head(), h("div", { class: "empty", style: "position:static;padding:60px" }, h("strong", {}, "Nothing to show"), h("p", {}, d.error)));
  const ids = V.list ? d.entries[V.list] || [] : d.tracks.map((t) => t.id), byId = new Map(d.tracks.map((t) => [t.id, t]));
  const rows = ids.map((id) => byId.get(id)).filter(Boolean);
  mount(panel, head(),
    d.managed ? null : h("div", { class: "stk-note" }, icon("i-warn", "i sm"),
      h("span", {}, d.older ? "An older Crate wrote this stick, so it can't be changed here yet. Export to it once and it can."
        : "rekordbox wrote this stick, so it can be browsed here but not changed. Exporting from Crate replaces what's on it.")),
    h("div", { class: "stk" },
      h("div", { class: "stk-lists" }, listRow({ id: 0, name: "All tracks" }, 0, d.tracks.length), ...tree(0, 0)),
      h("div", { class: "stk-tracks", tabindex: 0, onkeydown: (e) => { if ((e.key === "Delete" || e.key === "Backspace") && V.sel.size) removeTracks([...V.sel]); } },
        h("div", { class: "stk-row stk-headrow" }, h("span"), h("span", {}, "Title"), h("span", {}, "Artist"), h("span", { class: "num" }, "BPM"), h("span", {}, "Key"),
          h("span", { class: "num" }, "Time"), h("span", { class: "num" }, "Size"), h("span")),
        ...rows.map(trackRow),
        rows.length ? null : h("p", { class: "t3", style: "padding:20px 14px;margin:0" }, V.list ? "This playlist is empty." : "Nothing on this stick yet. Add playlists to put music on it."),
        h("div", { class: "stk-bar", hidden: true }))));
  bar();
}

function tree(pid, depth) {
  return V.data.playlists.filter((p) => p.parent === pid).flatMap((p) => [listRow(p, depth, p.folder ? null : (V.data.entries[p.id] || []).length), ...tree(p.id, depth + 1)]);
}

function listRow(p, depth, count) {
  const managed = V.data.managed && p.id;
  return h("div", { class: "item" + (V.list === p.id ? " on" : ""), style: `padding-left:${10 + depth * 14}px`,
    onclick: () => { if (p.folder) return; V.list = p.id; V.sel.clear(); draw($("#listPanel")); },
    oncontextmenu: p.id ? (e) => { e.preventDefault(); menu(e, [managed
      ? { label: `Remove ${p.folder ? "folder" : "playlist"} from stick`, icon: "i-trash", danger: true, run: () => removeList(p) }
      : { label: "Export to this stick from Crate to edit it", icon: "i-export", run: () => openExport({ stick: V.path }) }]); } : null },
  icon(p.id === 0 ? "i-library" : p.folder ? "i-folder" : "i-list", "i sm"), h("span", { class: "nm" }, p.name), count != null ? h("span", { class: "n" }, count) : null,
  managed ? h("button", { class: "btn sm icon ghost stk-x", "aria-label": "Remove from stick", "data-help": "<b>Remove from stick</b>",
    onclick: (e) => { e.stopPropagation(); removeList(p); } }, icon("i-x", "i sm")) : null);
}

function trackRow(t) {
  const el = h("label", { class: "stk-row", title: t.file, oncontextmenu: (e) => trackMenu(e, t) },
    !V.data.managed ? h("span") : h("input", { type: "checkbox", checked: V.sel.has(t.id), onchange: (e) => { e.target.checked ? V.sel.add(t.id) : V.sel.delete(t.id); el.classList.toggle("on", e.target.checked); bar(); } }),
    h("span", {}, t.title), h("span", { class: "t2" }, t.artist), h("span", { class: "num" }, t.bpm ? t.bpm.toFixed(1) : ""), h("span", { class: "t2" }, t.key),
    h("span", { class: "num t2" }, fmtTime(t.duration)), h("span", { class: "num t3" }, `${(t.size / 1e6).toFixed(1)} MB`),
    V.data.managed ? h("button", { class: "btn sm icon ghost stk-x", "aria-label": "Remove", "data-help": V.list ? "<b>Remove from this playlist</b>" : "<b>Remove from stick</b>",
      onclick: (e) => { e.preventDefault(); removeTracks([t.id]); } }, icon("i-x", "i sm")) : h("span"));
  return el;
}

// right-click: the ticked tracks if this is one of them, otherwise just this one
function trackMenu(e, t) {
  e.preventDefault();
  const ids = V.sel.has(t.id) ? [...V.sel] : [t.id], n = ids.length > 1 ? plural(ids.length, "track") : "track";
  if (!V.data.managed) return menu(e, [{ label: "Export to this stick from Crate to edit it", icon: "i-export", run: () => openExport({ stick: V.path }) }]);
  const list = V.list && V.data.playlists.find((p) => p.id === V.list);
  menu(e, [list ? { label: `Remove ${n} from ${list.name}`, icon: "i-list", run: () => removeTracks(ids, V.list) } : null,
    { label: `Remove ${n} from stick`, icon: "i-trash", danger: true, run: () => removeTracks(ids, null) }]);
}

// the selection bar: appears once tracks are ticked
function bar() {
  const el = $(".stk-bar"); if (!el) return;
  el.hidden = !V.sel.size;
  if (V.sel.size) mount(el, h("span", {}, `${plural(V.sel.size, "track")} selected`), h("div", { class: "spacer" }),
    h("button", { class: "btn sm", onclick: () => { V.sel.clear(); draw($("#listPanel")); } }, "Clear"),
    h("button", { class: "btn sm danger", onclick: () => removeTracks([...V.sel]) }, V.list ? "Remove from playlist" : "Remove from stick"));
}

const removeList = safe(async (p) => {
  const n = p.folder ? "everything in it" : plural((V.data.entries[p.id] || []).length, "track");
  if (!await confirmSheet(`Remove ${p.name} from the stick?`, `Takes the ${p.folder ? "folder" : "playlist"} and ${n} off. Tracks another playlist on the stick still uses stay.`, "Remove", true)) return;
  await change({ playlists: [p.id] });
});

// within: the playlist to take them out of; null takes them off the stick
const removeTracks = safe(async (ids, within = V.list || null) => {
  const where = within ? V.data.playlists.find((p) => p.id === within)?.name : null;
  if (!await confirmSheet(where ? `Remove ${plural(ids.length, "track")} from ${where}?` : `Remove ${plural(ids.length, "track")} from the stick?`,
    where ? "They stay on the stick if another playlist has them." : "They come out of every playlist on the stick and their files are deleted from it. Your own files aren't touched.", "Remove", true)) return;
  await change({ tracks: ids, within });
});

async function change(body) {
  await api("stick/remove", { path: V.path, ...body });
  toast("Updating the stick. Progress is in the status bar"); pollSoon();
}

on("stick", ({ root } = {}) => { if (S.view.kind === "stick" && (!root || root === V.path)) { V.data = null; renderStick($("#listPanel")); } });
