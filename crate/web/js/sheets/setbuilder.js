// Set builder: an opening track, an energy shape, and a mixable run of tracks.
import { h, mount, svg } from "../core/dom.js";
import { api, safe, toast } from "../core/api.js";
import { sheet } from "../core/ui.js";
import { S, loadNodes, nodeById, setView } from "../state.js";
import { deck } from "../library/preview.js";

const ARCS = [
  ["warmup", "Warm-up", "Builds steadily", "M2 30 C 30 28, 60 14, 98 6"],
  ["peak", "Peak time", "Up fast, stays up", "M2 24 C 10 8, 18 6, 30 6 L 98 6"],
  ["journey", "Journey", "Rise and return", "M2 28 C 30 28, 34 6, 50 6 S 70 28, 98 28"],
  ["closing", "Closing", "Winds down", "M2 6 C 40 8, 60 22, 98 30"],
];

export async function buildSetSheet(startId) {
  const start = S.byId.get(startId) || deck.t || S.byId.get([...S.sel][0]);
  if (!start || !start.analysed) return toast("Select or load the track you want to open with, then build the set.");
  let arc = "warmup";
  const len = h("input", { type: "range", min: 6, max: 40, value: 16, style: "flex:1" }), lenOut = h("b", { style: "width:28px;text-align:right" }, "16");
  len.oninput = () => { lenOut.textContent = len.value; };
  const pool = h("select", {}, h("option", { value: "" }, "Whole collection"), ...S.nodes.filter((n) => !n.is_folder).map((n) => h("option", { value: n.id }, n.name)));
  const name = h("input", { class: "field", value: `Set ${new Date().toLocaleDateString("en-GB")}`, style: "flex:1" });
  const arcs = h("div", { class: "arcs" });
  const drawArcs = () => mount(arcs, ...ARCS.map(([k, label, sub, d]) => {
    const pic = svg("svg", { viewBox: "0 0 100 36" });
    pic.append(svg("path", { d, fill: "none", stroke: arc === k ? "#ff9f2e" : "#6c6c75", "stroke-width": 2.2, "stroke-linecap": "round" }));
    return h("button", { class: "arc" + (arc === k ? " on" : ""), onclick: () => { arc = k; drawArcs(); } }, pic, h("b", {}, label), h("small", {}, sub));
  }));
  drawArcs();
  const ok = await sheet({ title: "Build a set", width: 600,
    text: `Opens with ${start.title}${start.camelot ? `, ${start.camelot}` : ""}${start.bpm ? ` at ${Math.round(start.bpm)} BPM` : ""}. Every transition is harmonically compatible and within 6% tempo, following the energy shape you pick.`,
    body: [h("div", { class: "glabel" }, "Energy shape"), arcs,
      h("div", { class: "group" }, h("div", { class: "gr" }, h("span", { class: "lbl" }, "Length"), len, lenOut, h("span", { class: "t3" }, "tracks")),
        h("div", { class: "gr" }, h("span", { class: "lbl" }, "Pick from"), pool), h("div", { class: "gr" }, h("span", { class: "lbl" }, "Name"), name))],
    actions: [{ label: "Cancel", result: false }, { label: "Build set", default: true, result: true }] });
  if (!ok) return;
  await safe(async () => {
    const r = await api("set", { start: start.id, length: +len.value, arc, pool: pool.value || null, name: name.value.trim() });
    await loadNodes(); S.open.add(nodeById(r.id)?.parent_id); setView({ kind: "node", id: r.id });
    toast(r.tracks.length < +len.value ? `Built ${r.tracks.length} tracks. That's as far as compatible tracks go from here` : `Built a ${r.tracks.length}-track set`);
  })();
}
