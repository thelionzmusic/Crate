// Settings: loudness, analysis, music folders, performance, library care, about.
import { h } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { emit } from "../core/bus.js";
import { askSheet, confirmSheet, gr, sheet, sw } from "../core/ui.js";
import { S, loadState, recomputeTarget, targetLufs } from "../state.js";
import { pollSoon } from "../jobs.js";
import { addFolder } from "./music.js";
import { chooseFile, installLatest } from "./updates.js";
import { go } from "../library/sidebar.js";
import { performSettings } from "../perform/settings.js";

const btn = (label, onclick, extra = {}) => h("button", { class: "btn sm", onclick, ...extra }, label);

export async function openSettings() {
  const st = S.settings;
  const set = (k) => safe(async (e) => { S.settings = await api("settings", { [k]: e.target.type === "checkbox" ? +e.target.checked : e.target.value }); recomputeTarget(); emit("tracks"); });
  const sticks = await api("drives").catch(() => []);
  const history = h("select", {}, ...sticks.map((d) => h("option", { value: d.path }, `${d.label} (${d.path})`)));
  await sheet({ title: "Settings", width: 620, body: [
    h("div", { class: "glabel" }, "Loudness"),
    h("div", { class: "group" },
      gr("Target", `Automatic picks the loudest level 9 in 10 of your tracks reach with plain gain (${targetLufs().toFixed(1)} LUFS right now)`,
        h("div", { style: "display:flex;gap:6px" }, h("select", { onchange: set("target_mode") }, h("option", { value: "auto", selected: st.target_mode === "auto" }, "Automatic"), h("option", { value: "fixed", selected: st.target_mode !== "auto" }, "Fixed")),
          h("input", { class: "field", type: "number", step: "0.5", min: "-20", max: "-5", value: st.target_lufs, style: "width:70px", onchange: set("target_lufs") }))),
      gr("True-peak ceiling", "No track is raised past this, so levelling can't clip", h("input", { class: "field", type: "number", step: "0.1", min: "-3", max: "0", value: st.ceiling, style: "width:70px", onchange: set("ceiling") }))),
    h("div", { class: "glabel" }, "Analysis"),
    h("div", { class: "group" },
      gr("BPM range", "Detected tempos are folded into this range", h("select", { onchange: set("bpm_min") }, ...[["68", "68 to 135"], ["78", "78 to 155"], ["88", "88 to 175"], ["98", "98 to 195"]].map(([v, l]) => h("option", { value: v, selected: st.bpm_min === v }, l)))),
      gr("Analyse everything again", "Grids, keys and cues you set yourself are kept",
        btn("Analyse", safe(async () => { if (await confirmSheet("Analyse every track again?", "It runs in the background on every core.", "Analyse")) { await api("analyse", {}); pollSoon(); } })))),
    h("div", { class: "glabel" }, "Music"),
    h("div", { class: "group" },
      ...S.state.folders.map((f) => gr(f, "Watched folder", btn("Stop watching", safe(async () => { await api("folders/remove", { path: f }); await loadState(); })))),
      gr("Add a folder", null, h("div", { style: "display:flex;gap:6px" }, btn("Add folder", addFolder), btn("Rescan", safe(async () => { await api("rescan", {}); pollSoon(); })))),
      gr("Import purchases from Downloads", "New tracks landing here are added and analysed automatically", sw("setWatch", st.watch_downloads === "1", set("watch_downloads"))),
      gr("Downloads folder", null, h("input", { class: "field", value: st.downloads, style: "width:240px", onchange: set("downloads") }))),
    ...await performSettings(),
    h("div", { class: "glabel" }, "Library care"),
    h("div", { class: "group" },
      gr("Find moved files", "Reconnects missing tracks with their cues and grids, by name or by sound", btn("Find", safe(async () => {
        let r = await api("relink", {});
        if (r.cancelled) { const p = await askSheet("Find moved files", "", "Folder to search, full path"); if (!p) return; r = await api("relink", { path: p }); }
        pollSoon();
      }))),
      gr("Find duplicates", "Compares every recording by sound", btn("Find", () => { S.dupes = null; go({ kind: "dupes" }); })),
      gr("Import play history", "Saves what you played from a stick's history into your History folder", h("div", { style: "display:flex;gap:6px" },
        sticks.length ? history : h("span", { class: "t3" }, "No stick plugged in"),
        btn("Import", safe(async () => { await api("history", { path: history.value }); pollSoon(); }), { disabled: !sticks.length })))),
    h("div", { class: "glabel" }, "About"),
    h("div", { class: "group" }, gr(`Crate ${S.state.version}`, `Analysis runs on ${S.state.workers} CPU thread${S.state.workers === 1 ? "" : "s"} at once.`,
      h("div", { style: "display:flex;gap:6px" }, S.state.update ? h("button", { class: "btn sm primary", onclick: installLatest }, `Install ${S.state.update.version}`) : null, btn("Install from file", chooseFile)))),
  ], actions: [{ label: "Done", default: true, result: true }] });
}
