// What next: tracks that mix out of this one, best first, with the reason for each.
import { h } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { emit } from "../core/bus.js";
import { sheet } from "../core/ui.js";
import { S } from "../state.js";
import { camelotColor } from "../core/format.js";

const ago = (d) => (d === 0 ? "played today" : d === 1 ? "played yesterday" : `played ${d} days ago`);

// rows of suggestions for `id`, each one loads on click. Used by the sheet and the Live view.
export async function nextRows(id, n = 12, onPick = (t) => emit("open", { id: t.id })) {
  const picks = await api("suggest", { id, n });
  return picks.map((p) => S.byId.get(p.id) && { p, t: S.byId.get(p.id) }).filter(Boolean).map(({ p, t }) =>
    h("button", { class: "nextrow", onclick: () => onPick(t) },
      h("div", { class: "grow" }, h("div", { class: "ttl" }, t.title), h("div", { class: "t3" }, [t.artist, ...p.why].filter(Boolean).join("   "))),
      p.played_days_ago != null && p.played_days_ago < 14 ? h("span", { class: "tag" }, ago(p.played_days_ago)) : null,
      h("span", { class: "num t2" }, t.bpm ? Math.round(t.bpm) : ""), t.camelot ? h("span", { class: "key", style: `--kc:${camelotColor(t.camelot)}` }, t.camelot) : h("span", { style: "min-width:32px" })));
}

export const whatNext = safe(async (t) => {
  const rows = await nextRows(t.id);
  await sheet({ title: `After ${t.title}`, width: 620,
    text: rows.length ? "Tracks that mix in on key and tempo, best first. Click one to load it." : "Nothing in your library mixes out of this on key and tempo yet.",
    body: (close) => (rows.length ? h("div", { class: "group nextlist", onclick: (e) => e.target.closest(".nextrow") && close(true) }, ...rows) : null),
    actions: [{ label: "Done", default: true, result: true }] });
});
