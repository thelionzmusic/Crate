// The browser on the left: library views and the playlist tree.
import { $, h, icon, mount } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { on } from "../core/bus.js";
import { askSheet, confirmSheet, menu } from "../core/ui.js";
import { setPref } from "../core/prefs.js";
import { S, loadNodes, nodeById, setView } from "../state.js";
import { scanDuplicates } from "./views.js";
import { smartSheet } from "../sheets/smart.js";
import { buildSetSheet } from "../sheets/setbuilder.js";

export function go(view) { setView(view); if (view.kind === "dupes" && !S.dupes) scanDuplicates(); }

function render() {
  const issues = S.rows.filter((t) => t.issues && t.issues.length).length;
  const isOn = (v) => S.view.kind === v.kind && S.view.id === v.id;
  const item = (label, view, right, ic, help) => h("div", { class: "item" + (isOn(view) ? " on" : ""), tabindex: 0, "data-help": help, onclick: () => go(view), onkeydown: (e) => e.key === "Enter" && go(view) },
    icon(ic), h("span", { class: "nm" }, label), right);
  mount($("#side"),
    h("h3", {}, "Library"),
    item("Collection", { kind: "all" }, h("span", { class: "n" }, S.rows.length), "i-library", "<b>Collection</b>  Every track Crate knows about"),
    item("Issues", { kind: "issues" }, issues ? h("span", { class: "count warn" }, issues) : null, "i-warn",
      "<b>Issues</b>  Tracks worth fixing: missing files, failed analysis, and sound problems like upscaled MP3s, low bitrates or clipping. Each track says why"),
    item("Duplicates", { kind: "dupes" }, S.dupes && S.dupes.length ? h("span", { class: "n" }, S.dupes.length) : null, "i-copy", "<b>Duplicates</b>  The same recording more than once, matched by sound"),
    item("Wishlist", { kind: "wish" }, null, "i-heart", "<b>Wishlist</b>  Tracks to buy, with store search"),
    h("h3", {}, "Playlists", h("button", { class: "btn sm icon ghost", "aria-label": "New", "data-help": "<b>New</b>  Playlist, folder, smart playlist or set",
      onclick: (e) => menu(e, [{ label: "New playlist", icon: "i-list", kbd: "Ctrl+N", run: () => newNode(0, false) }, { label: "New folder", icon: "i-folder", run: () => newNode(0, true) },
        { label: "New smart playlist", icon: "i-smart", run: () => smartSheet() }, "-", { label: "Build a set", icon: "i-set", run: () => buildSetSheet() }]) }, icon("i-plus", "i sm"))),
    ...tree(0, 0, isOn),
    S.nodes.length ? null : h("div", { class: "item t3" }, "No playlists yet"));
}

function tree(pid, depth, isOn) {
  return S.nodes.filter((n) => n.parent_id === pid).flatMap((n) => {
    const open = S.open.has(n.id), ic = n.is_folder ? "i-folder" : n.rules ? "i-smart" : pid && nodeById(pid)?.name === "History" ? "i-history" : "i-list";
    const row = h("div", { class: "item" + (isOn({ kind: "node", id: n.id }) ? " on" : ""), tabindex: 0, style: `padding-left:${8 + depth * 14}px`,
      "data-help": n.rules ? "<b>Smart playlist</b>  Fills itself from rules. Right-click to edit them" : n.is_folder ? "<b>Folder</b>" : "<b>Playlist</b>  Drop tracks here. Double-click or F2 to rename",
      onclick: () => { if (!n.is_folder) return go({ kind: "node", id: n.id }); open ? S.open.delete(n.id) : S.open.add(n.id); setPref("open", [...S.open]); render(); },
      ondblclick: () => rename(row, n), onkeydown: (e) => e.key === "F2" && rename(row, n),
      oncontextmenu: (e) => { e.preventDefault(); nodeMenu(e, n, row); },
      ondragover: (e) => { if (!n.is_folder && !n.rules) { e.preventDefault(); row.classList.add("drop"); } },
      ondragleave: () => row.classList.remove("drop"),
      ondrop: safe(async (e) => {
        e.preventDefault(); e.stopPropagation(); row.classList.remove("drop");
        const ids = JSON.parse(e.dataTransfer.getData("text/crate-ids") || "[]"), add = ids.filter((i) => !n.tracks.includes(i));
        n.tracks = [...n.tracks, ...add]; await api("node/tracks", { id: n.id, tracks: n.tracks }); render();
        toast(`Added ${add.length} to ${n.name}${ids.length > add.length ? `. ${ids.length - add.length} already there` : ""}`, 2500);
      }),
    }, h("span", { class: "tw" + (open ? " open" : "") }, n.is_folder ? icon("i-chev") : ""), icon(ic), h("span", { class: "nm" }, n.name), h("span", { class: "n" }, n.is_folder ? "" : n.tracks.length));
    return [row, ...(n.is_folder && open ? tree(n.id, depth + 1, isOn) : [])];
  });
}

function rename(row, n) {
  const nm = row.querySelector(".nm"); if (!nm) return;
  const input = h("input", { value: n.name, "aria-label": "Name" });
  const done = safe(async (keep) => {
    if (!input.isConnected) return;
    const v = input.value.trim(); input.replaceWith(nm);
    if (keep && v && v !== n.name) { await api("node/update", { id: n.id, name: v }); await loadNodes(); }
  });
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); };
  input.onblur = () => done(true); input.onclick = (e) => e.stopPropagation();
  nm.replaceWith(input); input.focus(); input.select();
}

export const newNode = safe(async (parent, folder) => {
  const name = await askSheet(folder ? "New folder" : "New playlist", folder ? "New folder" : "New playlist"); if (!name) return;
  const { id } = await api("node/create", { name, parent_id: parent, is_folder: folder });
  if (parent) S.open.add(parent);
  await loadNodes(); if (!folder) go({ kind: "node", id });
});

function nodeMenu(e, n, row) {
  const move = (parent) => safe(() => api("node/update", { id: n.id, parent_id: parent }).then(loadNodes));
  menu(e, [
    { label: "Rename", kbd: "F2", run: () => rename(row, n) },
    n.rules ? { label: "Edit rules", icon: "i-smart", run: () => smartSheet(n) } : null,
    n.is_folder ? { label: "New playlist inside", icon: "i-list", run: () => newNode(n.id, false) } : null,
    n.is_folder ? { label: "New folder inside", icon: "i-folder", run: () => newNode(n.id, true) } : null,
    "-",
    n.parent_id ? { label: "Move to top level", run: move(0) } : null,
    ...S.nodes.filter((f) => f.is_folder && f.id !== n.id).slice(0, 8).map((f) => ({ label: `Move into ${f.name}`, icon: "i-folder", run: move(f.id) })),
    "-",
    { label: "Delete", danger: true, run: safe(async () => {
      if (!await confirmSheet(`Delete "${n.name}"?`, n.is_folder ? "Everything inside goes too. Tracks stay in your collection." : "Tracks stay in your collection.", "Delete", true)) return;
      await api("node/delete", { id: n.id });
      if (S.view.id === n.id) setView({ kind: "all" });
      await loadNodes();
    }) },
  ]);
}

export function init() {
  for (const ev of ["tracks", "nodes", "view", "job"]) on(ev, render);
}
