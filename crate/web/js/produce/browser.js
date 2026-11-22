// The browser down the left: Crate's audio effects, sample categories, your sample folders,
// Crate's library, a search box and one line per result. Click previews a sound; drag drops
// into a slot, a lane, a device chain or empty space; double-click puts an effect on the
// selected track.
import { $, h, icon, mount } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { pref, setPref } from "../core/prefs.js";
import { S } from "../state.js";
import { studio } from "./engine.js";
import { DRAG_TYPE, P, addDevice, drag, edit, owner } from "./set.js";
import { CATEGORIES as FX_CATEGORIES, DEVICES } from "./fx/devices.js";

const SHOWN = 400;  // rows drawn at once; searching narrows the rest
const CATEGORIES = [
  ["Samples", () => true],
  ["Drums", (p) => /kick|snare|hat|clap|perc|drum|tom|cymb|ride|crash|rim|shaker|808|909|break/i.test(p)],
  ["Loops", (p) => /loop|\d{2,3}\s?bpm/i.test(p)],
  ["One-shots", (p) => /one.?shot|\bhit\b|\bshot\b/i.test(p)],
  ["Vocals", (p) => /vox|vocal|acapella|chant/i.test(p)],
  ["FX", (p) => /\bfx\b|riser|sweep|impact|downlifter|uplifter|noise|whoosh/i.test(p)],
];

const B = { samples: { folders: [], files: [] }, place: pref("produceBrowse", "cat:Samples"), q: "", el: null };

export async function initBrowser(el) {
  B.el = el;
  mount(el,
    h("div", { class: "pb-search" }, icon("i-search"), h("input", { class: "field", type: "search", placeholder: "Search", "aria-label": "Search sounds",
      oninput: (e) => { B.q = e.target.value.trim().toLowerCase(); results(); } })),
    h("div", { class: "pb-places" }),
    h("div", { class: "pb-results", role: "listbox" }));
  B.samples = await api("samples");
  if (B.place.startsWith("f:") && !B.samples.folders[+B.place.slice(2)]) B.place = "cat:Samples";  // a folder removed since
  places(); results();
}

function places() {
  const item = (key, label, ico, extra) => h("button", { class: "pb-place" + (B.place === key ? " on" : ""), onclick: () => { B.place = key; setPref("produceBrowse", key); places(); results(); } },
    icon(ico, "i sm"), h("span", {}, label), extra);
  mount($(".pb-places", B.el),
    h("h4", {}, "Devices"),
    item("fx", "Audio Effects", "i-fx"),
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
  if (B.place === "fx") return effects(words, hit);
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

// Crate's effects, grouped as Ableton groups them
function effects(words, hit) {
  const box = $(".pb-results", B.el), groups = FX_CATEGORIES.map((cat) => [cat, Object.entries(DEVICES).filter(([, d]) => d.cat === cat && (!words.length || hit(`${d.name} ${cat}`.toLowerCase())))]);
  const shown = groups.filter(([, list]) => list.length);
  if (!shown.length) return mount(box, h("p", { class: "pb-empty" }, "No effect matches"));
  mount(box, ...shown.flatMap(([cat, list]) => [h("div", { class: "pb-group" }, cat), ...list.map(([type, d]) => fxRow(type, d))]));
}

function fxRow(type, d) {
  const el = h("div", { class: "pb-row", role: "option", draggable: "true", "data-help": `<b>${d.name}</b>  ${d.help}. Drag onto a track or the devices below, or double-click to add it to the selected track`,
    onclick: () => { $(".pb-row.on", B.el)?.classList.remove("on"); el.classList.add("on"); },
    ondblclick: () => { const o = owner(P.sel); if (o) edit(() => addDevice(o, type)); },
    ondragstart: (e) => { drag.item = { kind: "device", type }; e.dataTransfer.setData(DRAG_TYPE, "1"); e.dataTransfer.effectAllowed = "copy"; },
    ondragend: () => { drag.item = null; } },
  icon("i-fx", "i sm"), h("span", {}, d.name));
  return el;
}

const srcOf = (item) => (item.kind === "track" ? { kind: "track", id: item.id } : { kind: "sample", f: item.f, p: item.p });
