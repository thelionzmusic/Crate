// Export to USB: which sticks, which players, which playlists, how it sounds.
import { $, h, icon } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { gr, sheet, sw } from "../core/ui.js";
import { S, targetLufs } from "../state.js";
import { pollSoon } from "../jobs.js";
import { checkStick } from "./check.js";

export const openExport = safe(async () => {
  const st = S.settings, drives = await api("drives"), picked = new Set(), sticks = new Set(drives.length ? [drives[0].path] : []);
  const tree = (pid, depth) => S.nodes.filter((n) => n.parent_id === pid).flatMap((n) => [h("label", { style: `padding-left:${12 + depth * 16}px` },
    h("input", { type: "checkbox", onchange: (e) => (e.target.checked ? picked.add(n.id) : picked.delete(n.id)) }), icon(n.is_folder ? "i-folder" : n.rules ? "i-smart" : "i-list", "i sm"), n.name,
    h("span", { class: "t3", style: "margin-left:auto" }, n.is_folder ? "" : n.tracks.length)), ...tree(n.id, depth + 1)]);
  const path = h("input", { class: "field", placeholder: "Or a folder path, e.g. E:\\", style: "flex:1" });
  const ok = await sheet({ title: "Export to USB", width: 600,
    body: [
      h("div", { class: "glabel" }, "Sticks"),
      h("div", { class: "group" }, ...(drives.length ? drives.map((d, i) => h("label", { class: "check", style: "padding:8px 12px" },
        h("input", { type: "checkbox", checked: i === 0, onchange: (e) => (e.target.checked ? sticks.add(d.path) : sticks.delete(d.path)) }),
        h("div", { class: "lbl", style: "flex:1" }, `${d.label}  (${d.path})`, h("small", { class: "t3", style: "display:block" }, `${d.fs || "Unknown format"}, ${d.free_gb} GB free of ${d.total_gb} GB`)),
        h("button", { class: "btn sm", "data-help": "<b>Check stick</b>  Reads the stick back the way a CDJ does and lists anything a player would trip over",
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); checkStick(d.path); } }, "Check")))
        : [h("div", { class: "gr t3" }, "No USB drives found. Plug one in, or type a path below.")]), h("div", { class: "gr" }, path)),
      h("div", { class: "glabel" }, "Players"),
      h("div", { class: "group" }, h("div", { class: "gr" }, h("select", { id: "exProfile", style: "flex:1" }, ...S.state.profiles.map((p) => h("option", { value: p.key, selected: p.key === st.profile }, p.label))))),
      h("div", { class: "glabel" }, "Playlists"),
      h("div", { class: "group" }, S.nodes.length ? h("div", { class: "tree" }, ...tree(0, 0)) : h("div", { class: "gr t3" }, "No playlists yet, so the whole collection goes on."),
        gr("Whole collection", "Browse every track on the player by artist, genre, BPM and key", sw("exAll", !S.nodes.length))),
      h("div", { class: "glabel" }, "Sound and display"),
      h("div", { class: "group" },
        gr(`Match loudness to ${targetLufs().toFixed(1)} LUFS`, "Plain gain on the copies, never past -1 dBTP. Nothing is limited, and your files are never changed", sw("exLevel", st.level !== "0")),
        gr("Energy in the comment", "Adds E1 to E10 at the start of each comment, so it shows on the player", sw("exEnergy", st.energy_comment === "1")),
        gr("Phrase lanes on CDJ-3000", "Experimental. Shows Crate's intro, drop and breakdown markers on the player", sw("exPhrases", st.phrase_export === "1")),
        gr("Browse-menu tables", "Leave on. If a player hangs loading a stick, export once with this off", sw("exMenu", st.menu_tables !== "0"))),
      h("p", { class: "t3", style: "margin:0" }, "Any play history on the stick is saved to your History folder before it's updated."),
    ],
    actions: [{ label: "Cancel", result: false }, { label: "Export", default: true, value: () => {
      const paths = [...sticks, ...(path.value.trim() ? [path.value.trim()] : [])];
      if (!paths.length) { toast("Choose a stick or type a folder path."); return undefined; }
      if (!picked.size && !$("#exAll").checked && S.nodes.length) { toast("Pick a playlist, or include the whole collection."); return undefined; }
      return { paths, all: $("#exAll").checked || !S.nodes.length, profile: $("#exProfile").value, level: $("#exLevel").checked, energy: $("#exEnergy").checked, phrases: $("#exPhrases").checked, menu: $("#exMenu").checked };
    } }] });
  if (!ok) return;
  await api("settings", { menu_tables: +ok.menu, phrase_export: +ok.phrases, energy_comment: +ok.energy });
  await api("export", { paths: ok.paths, nodes: S.nodes.length ? [...picked] : null, everything: ok.all, profile: ok.profile, level: ok.level, menu_tables: ok.menu, phrases: ok.phrases });
  toast(`Exporting to ${ok.paths.length} stick${ok.paths.length > 1 ? "s" : ""}. Progress is in the status bar`); pollSoon();
});
