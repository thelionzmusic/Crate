// Check stick: what a player would trip over on a stick, from reading it back the way a CDJ does.
import { h, icon } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { sheet } from "../core/ui.js";
import { pollSoon } from "../jobs.js";

export const checkStick = safe(async (path) => { await api("stick/check", { path }); pollSoon(); });

export function showCheck(r) {
  const head = r.ok
    ? `${r.tracks} tracks and ${r.playlists} playlists read back cleanly${r.warnings ? `, with ${r.warnings} thing${r.warnings > 1 ? "s" : ""} worth knowing` : ""}.`
    : `${r.errors} problem${r.errors > 1 ? "s" : ""} a player would trip over, across ${r.tracks} tracks.`;
  // one row per issue, grouped so 400 tracks with the same fault read as one line
  const groups = new Map();
  for (const p of r.problems) {
    const k = `${p.level}|${p.issue}`;
    if (!groups.has(k)) groups.set(k, { ...p, titles: [] });
    groups.get(k).titles.push(p.title);
  }
  const rows = [...groups.values()].sort((a, b) => (a.level === "error" ? 0 : 1) - (b.level === "error" ? 0 : 1)).map((g) =>
    h("div", { class: `chk ${g.level}` }, icon("i-warn", "i sm"),
      h("div", {}, h("div", {}, g.issue),
        g.titles[0] !== "Stick" && g.titles[0] !== "Playlists"
          ? h("small", { class: "t3" }, g.titles.length > 3 ? `${g.titles.slice(0, 3).join(", ")} and ${g.titles.length - 3} more` : g.titles.join(", ")) : null)));
  return sheet({ title: r.ok ? "Stick looks good" : "Stick needs attention", text: head, width: 620,
    body: rows.length ? h("div", { class: "group" }, ...rows) : null,
    actions: [{ left: r.filesystem ? `${r.root || ""}  ${r.filesystem}` : "" }, { label: "Done", default: true, result: true }] });
}
