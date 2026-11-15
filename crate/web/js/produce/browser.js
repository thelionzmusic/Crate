// The browser down the left: categories, your sample folders, Crate's library, a search box
// and one line per result. Click previews, drag drops into a slot, a lane or empty space.
import { $, h, icon, mount } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { S } from "../state.js";
import { studio } from "./engine.js";
import { DRAG_TYPE, drag } from "./set.js";

const SHOWN = 400;  // rows drawn at once; searching narrows the rest
const CATEGORIES = [
  ["Samples", () => true],
  ["Drums", (p) => /kick|snare|hat|clap|perc|drum|tom|cymb|ride|crash|rim|shaker|808|909|break/i.test(p)],
  ["Loops", (p) => /loop|\d{2,3}\s?bpm/i.test(p)],
  ["One-shots", (p) => /one.?shot|\bhit\b|\bshot\b/i.test(p)],
  ["Vocals", (p) => /vox|vocal|acapella|chant/i.test(p)],
  ["FX", (p) => /\bfx\b|riser|sweep|impact|downlifter|uplifter|noise|whoosh/i.test(p)],
];

const B = { samples: { folders: [], files: [] }, place: "cat:Samples", q: "", el: null };

export async function initBrowser(el) {
  B.el = el;
  mount(el,
    h("div", { class: "pb-search" }, icon("i-search"), h("input", { class: "field", type: "search", placeholder: "Search", "aria-label": "Search sounds",
      oninput: (e) => { B.q = e.target.value.trim().toLowerCase(); results(); } })),
    h("div", { class: "pb-places" }),
    h("div", { class: "pb-results", role: "listbox" }));
  B.samples = await api("samples");
  places(); results();
}

function places() {
  const item = (key, label, ico, extra) => h("button", { class: "pb-place" + (B.place === key ? " on" : ""), onclick: () => { B.place = key; places(); results(); } },
    icon(ico, "i sm"), h("span", {}, label), extra);
  mount($(".pb-places", B.el),
    h("h4", {}, "Library"),
    ...CATEGORIES.map(([name]) => item(`cat:${name}`, name, "i-wave")),
    item("tracks", "Crate tracks", "i-deck"),
    h("h4", {}, "Places"),
    ...B.samples.folders.map((f, i) => item(`f:${i}`, f.split(/[\\/]/).filter(Boolean).pop(), "i-folder",
      h("i", { class: "pb-x", title: "Remove from Places", onclick: safe(async (e) => { e.stopPropagation(); B.samples = await api("samples/folder", { remove: f }); B.place = "cat:Samples"; places(); results(); }) }, icon("i-x", "i sm")))),
    h("button", { class: "pb-place add", onclick: safe(async () => { B.samples = await api("samples/folder", {}); places(); results(); }) }, icon("i-plus", "i sm"), h("span", {}, "Add folder…")));
}

function results() {
  const q = B.q, words = q.split(/\s+/).filter(Boolean), hit = (s) => words.every((w) => s.includes(w));
  let rows;
  if (B.place === "tracks") {
    rows = S.rows.filter((t) => !q || hit(`${t.artist} ${t.title}`.toLowerCase()))
      .map((t) => ({ item: { kind: "track", id: t.id }, name: `${t.artist ? t.artist + " - " : ""}${t.title}`, note: t.bpm ? t.bpm.toFixed(0) : "" }));
  } else {
    const [kind, arg] = B.place.split(":"), test = kind === "cat" ? CATEGORIES.find(([n]) => n === arg)[1] : null;
    rows = B.samples.files.filter(([f, p]) => (test ? test(p) : f === +arg) && (!q || hit(p.toLowerCase())))
      .map(([f, p]) => ({ item: { kind: "sample", f, p }, name: p.split("/").pop(), note: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "" }));
  }
  const box = $(".pb-results", B.el), n = rows.length;
  if (!n) {
    const empty = B.place === "tracks" ? "No tracks match" : !B.samples.folders.length ? "Add a folder of samples under Places to browse it here" : "Nothing matches";
    return mount(box, h("p", { class: "pb-empty" }, empty));
  }
  mount(box, ...rows.slice(0, SHOWN).map(row), n > SHOWN ? h("p", { class: "pb-empty" }, `${SHOWN} of ${n.toLocaleString()} shown. Search to narrow them down`) : null);
}

function row(r) {
  const el = h("div", { class: "pb-row", role: "option", draggable: "true", title: r.note ? `${r.note}/${r.name}` : r.name,
    onclick: safe(async () => { $(".pb-row.on", B.el)?.classList.remove("on"); el.classList.add("on"); await studio.preview(srcOf(r.item)); }),
    ondragstart: (e) => { drag.item = r.item; e.dataTransfer.setData(DRAG_TYPE, "1"); e.dataTransfer.effectAllowed = "copy"; },
    ondragend: () => { drag.item = null; } },
  icon(r.item.kind === "track" ? "i-deck" : "i-wave", "i sm"), h("span", {}, r.name), r.note && r.item.kind === "track" ? h("small", {}, r.note) : null);
  return el;
}

const srcOf = (item) => (item.kind === "track" ? { kind: "track", id: item.id } : { kind: "sample", f: item.f, p: item.p });
