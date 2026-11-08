// Smart playlist editor: rules, a live match count, save.
import { h, icon, mount } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { sheet } from "../core/ui.js";
import { loadNodes, setView } from "../state.js";

const FIELDS = {
  bpm: ["BPM", "number"], energy: ["Energy", "number"], camelot: ["Key", "key"], genre: ["Genre", "text"], artist: ["Artist", "text"],
  label: ["Label", "text"], title: ["Title", "text"], comment: ["Comment", "text"], rating: ["Rating", "number"], plays: ["Plays", "number"],
  year: ["Year", "number"], lufs: ["Loudness (LUFS)", "number"], date_added: ["Date added", "date"], has_vocals: ["Vocals", "flag"], has_issues: ["Issues", "flag"],
};
const OPS = {
  number: [["between", "is between"], [">=", "is at least"], ["<=", "is at most"], ["=", "is"]],
  text: [["contains", "contains"], ["is", "is"], ["not_contains", "doesn't contain"]],
  key: [["compatible", "mixes with"], ["in", "is one of"]], date: [["within_days", "in the last"]], flag: [["is", "is"]],
};
const kindOf = (r) => FIELDS[r.field][1];
const defaults = (r) => ({ between: [120, 130], ">=": 7, "<=": 5, "=": 0, contains: "", is: kindOf(r) === "flag" ? true : "", not_contains: "", compatible: "8A", in: "8A 9A", within_days: 30 })[r.op];
const clean = (rules) => rules.map((r) => ({ ...r, value: kindOf(r) === "number" && r.op === "between" ? [+r.value[0], +r.value[1]]
  : kindOf(r) === "flag" ? r.value !== false && r.value !== "false" : r.op === "in" ? String(r.value).split(/[ ,]+/).filter(Boolean) : r.value }));

export async function smartSheet(node) {
  const rules = node?.rules?.rules?.length ? structuredClone(node.rules.rules) : [{ field: "bpm", op: "between", value: [124, 128] }];
  let match = node?.rules?.match || "all";
  const name = h("input", { class: "field", value: node?.name || "New smart playlist", style: "flex:1" });
  const list = h("div", { class: "group" }), count = h("span", {});
  let seq = 0;
  const preview = async () => {
    const mine = ++seq;
    try { const r = await api("smart/preview", { rules: { match, rules: clean(rules) } }); if (mine === seq) count.textContent = `${r.count} track${r.count === 1 ? "" : "s"} match`; }
    catch (e) { count.textContent = e.message; }
  };
  const update = () => { draw(); preview(); };
  const draw = () => mount(list, ...rules.map((r, i) => {
    const kind = kindOf(r), set = (v) => { r.value = v; preview(); };
    const field = h("select", { onchange: (e) => { r.field = e.target.value; r.op = OPS[kindOf(r)][0][0]; r.value = defaults(r); update(); } },
      ...Object.entries(FIELDS).map(([k, [l]]) => h("option", { value: k, selected: k === r.field }, l)));
    const op = h("select", { onchange: (e) => { r.op = e.target.value; r.value = defaults(r); update(); } }, ...OPS[kind].map(([k, l]) => h("option", { value: k, selected: k === r.op }, l)));
    const vals = r.op === "between"
      ? [h("input", { class: "field", type: "number", value: r.value[0], oninput: (e) => set([e.target.value, r.value[1]]) }), h("input", { class: "field", type: "number", value: r.value[1], oninput: (e) => set([r.value[0], e.target.value]) })]
      : kind === "flag" ? [h("select", { onchange: (e) => set(e.target.value === "yes") }, h("option", { value: "yes", selected: r.value !== false }, "present"), h("option", { value: "no", selected: r.value === false }, "absent"))]
        : [h("input", { class: "field", type: kind === "number" || kind === "date" ? "number" : "text", value: Array.isArray(r.value) ? r.value.join(" ") : r.value, placeholder: kind === "date" ? "days" : r.op === "in" ? "8A 9A 8B" : "", oninput: (e) => set(e.target.value) })];
    return h("div", { class: "rule" }, field, op, h("div", { class: "vals" }, ...vals),
      h("button", { class: "btn sm icon ghost", "aria-label": "Remove rule", onclick: () => { rules.splice(i, 1); update(); } }, icon("i-x", "i sm")));
  }), h("div", { class: "gr" }, h("button", { class: "btn sm", onclick: () => { rules.push({ field: "genre", op: "contains", value: "" }); draw(); } }, icon("i-plus", "i sm"), "Add rule"),
    h("div", { class: "spacer" }), h("span", { class: "t3" }, "Match"),
    h("div", { class: "seg" }, ...["all", "any"].map((m) => h("button", { class: "btn sm" + (match === m ? " on" : ""), onclick: () => { match = m; update(); } }, m)))));
  update();
  const ok = await sheet({ title: node ? "Edit smart playlist" : "New smart playlist", width: 640,
    text: "A playlist that fills itself. As tracks are added or analysed, it stays current, and it exports like any other playlist.",
    body: [h("div", { style: "display:flex;gap:8px" }, name), list], actions: [{ left: count }, { label: "Cancel", result: false }, { label: node ? "Save" : "Create", default: true, result: true }] });
  if (!ok) return;
  await safe(async () => {
    const body = { name: name.value.trim() || "Smart playlist", rules: { match, rules: clean(rules) } };
    if (node) { await api("node/update", { id: node.id, ...body }); await loadNodes(); }
    else { const { id } = await api("node/create", { ...body, parent_id: 0 }); await loadNodes(); setView({ kind: "node", id }); }
  })();
}
