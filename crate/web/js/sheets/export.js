// Export to USB: which sticks, which players, which playlists, how it sounds.
import { $, h, icon, mount } from "../core/dom.js";
import { plural } from "../core/format.js";
import { api, safe, toast } from "../core/api.js";
import { gr, sheet, sw } from "../core/ui.js";
import { S, targetLufs } from "../state.js";
import { pollSoon } from "../jobs.js";
import { checkStick } from "./check.js";

// `stick`: tick that stick (from its device view) rather than the first one found
export const openExport = safe(async ({ stick } = {}) => {
  const st = S.settings, drives = await api("drives"), picked = new Set();
  const sticks = new Set(drives.some((d) => d.path === stick) ? [stick] : drives.length ? [drives[0].path] : []);
  const boxes = new Map(), tags = new Map();
  const tree = (pid, depth) => S.nodes.filter((n) => n.parent_id === pid).flatMap((n) => {
    const box = h("input", { type: "checkbox", onchange: (e) => { e.target.checked ? picked.add(n.id) : picked.delete(n.id); estimate(); } });
    const tag = h("span", { class: "tag", hidden: true }, "on stick");
    boxes.set(n.id, box); tags.set(n.id, tag);
    return [h("label", { style: `padding-left:${12 + depth * 16}px` }, box, icon(n.is_folder ? "i-folder" : n.rules ? "i-smart" : "i-list", "i sm"), n.name, tag,
      h("span", { class: "t3", style: "margin-left:auto" }, n.is_folder ? "" : n.tracks.length)), ...tree(n.id, depth + 1)];
  });
  const est = h("div", { class: "gr ex-est t2" }, "Pick what to put on the stick.");
  // what the export adds, the space and time it takes; playlists already on the stick are tagged
  let seq = 0, first = true;
  const estimate = async () => {
    const mine = ++seq; await new Promise((r) => setTimeout(r, 150)); if (mine !== seq) return;
    const paths = [...sticks]; if (!paths.length) return mount(est, "Choose a stick.");
    const all = $("#exAll")?.checked || !S.nodes.length;
    const res = await api("export/estimate", { paths, nodes: S.nodes.length ? [...picked] : null, everything: all, replace: $("#exReplace")?.checked, profile: $("#exProfile")?.value });
    if (mine !== seq) return;
    const on = new Set(paths.flatMap((p) => res[p]?.on_stick || []));
    for (const [id, tag] of tags) tag.hidden = !on.has(id);
    if (first) { first = false; for (const id of on) { boxes.get(id) && (boxes.get(id).checked = true); picked.add(id); } if (on.size) return estimate(); }
    mount(est, ...paths.map((p) => { const e = res[p], d = drives.find((x) => x.path === p); if (!e) return null;
      const mins = Math.max(1, Math.round(e.seconds / 60));
      return h("div", { class: e.fits ? "" : "bad" }, h("b", {}, d ? d.label : p), `  ${plural(e.tracks, "track")}, ${e.new ? `${e.new} new, ${(e.bytes / 1e9).toFixed(1)} GB to copy` : "nothing new to copy"}, about ${mins} min. ${(e.free / 1e9).toFixed(1)} GB free`,
        e.fits ? null : h("span", {}, ". It won't fit")); }));
  };
  const path = h("input", { class: "field", placeholder: "Or a folder path, e.g. E:\\", style: "flex:1" });
  estimate();
  const ok = await sheet({ title: "Export to USB", width: 600,
    body: [
      h("div", { class: "glabel" }, "Sticks"),
      h("div", { class: "group" }, ...(drives.length ? drives.map((d, i) => h("label", { class: "check", style: "padding:8px 12px" },
        h("input", { type: "checkbox", checked: sticks.has(d.path), onchange: (e) => { e.target.checked ? sticks.add(d.path) : sticks.delete(d.path); estimate(); } }),
        h("div", { class: "lbl", style: "flex:1" }, `${d.label}  (${d.path})`, h("small", { class: "t3", style: "display:block" }, `${d.fs || "Unknown format"}, ${d.free_gb} GB free of ${d.total_gb} GB${d.library ? ", has a library" : ""}`)),
        h("button", { class: "btn sm", "data-help": "<b>Check stick</b>  Reads the stick back the way a CDJ does and lists anything a player would trip over",
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); checkStick(d.path); } }, "Check")))
        : [h("div", { class: "gr t3" }, "No USB drives found. Plug one in, or type a path below.")]), h("div", { class: "gr" }, path)),
      h("div", { class: "glabel" }, "Players"),
      h("div", { class: "group" }, h("div", { class: "gr" }, h("select", { id: "exProfile", style: "flex:1", onchange: () => estimate() }, ...S.state.profiles.map((p) => h("option", { value: p.key, selected: p.key === st.profile }, p.label))))),
      h("div", { class: "glabel" }, "Playlists"),
      h("div", { class: "group" }, S.nodes.length ? h("div", { class: "tree" }, ...tree(0, 0)) : h("div", { class: "gr t3" }, "No playlists yet, so the whole collection goes on."),
        gr("Whole collection", "Browse every track on the player by artist, genre, BPM and key", sw("exAll", !S.nodes.length, () => estimate())),
        gr("Replace what's on the stick", "Off: these are added to what Crate already put on it, as rekordbox does. A stick rekordbox wrote is always replaced", sw("exReplace", false, () => estimate())), est),
      h("div", { class: "glabel" }, "Sound and display"),
      h("div", { class: "group" },
        gr(`Match loudness to ${targetLufs().toFixed(1)} LUFS`, "Plain gain on the copies, never past -1 dBTP. Nothing is limited, and your files are never changed", sw("exLevel", st.level !== "0")),
        gr("Energy in the comment", "Adds E1 to E10 at the start of each comment, so it shows on the player", sw("exEnergy", st.energy_comment === "1"))),
      h("p", { class: "t3", style: "margin:0" }, "Any play history on the stick is saved to your History folder before it's updated."),
    ],
    actions: [{ label: "Cancel", result: false }, { label: "Export", default: true, value: () => {
      const paths = [...sticks, ...(path.value.trim() ? [path.value.trim()] : [])];
      if (!paths.length) { toast("Choose a stick or type a folder path."); return undefined; }
      if (!picked.size && !$("#exAll").checked && S.nodes.length) { toast("Pick a playlist, or include the whole collection."); return undefined; }
      return { paths, all: $("#exAll").checked || !S.nodes.length, profile: $("#exProfile").value, level: $("#exLevel").checked, energy: $("#exEnergy").checked, replace: $("#exReplace").checked };
    } }] });
  if (!ok) return;
  await api("settings", { energy_comment: +ok.energy });
  await api("export", { paths: ok.paths, nodes: S.nodes.length ? [...picked] : null, everything: ok.all, profile: ok.profile, level: ok.level, replace: ok.replace });
  toast(`Exporting to ${ok.paths.length} stick${ok.paths.length > 1 ? "s" : ""}. Progress is in the status bar`); pollSoon();
});
