// Settings: loudness, analysis, music folders, performance, library care, about.
import { h } from "../core/dom.js";
import { api, safe } from "../core/api.js";
import { emit } from "../core/bus.js";
import { askSheet, confirmSheet, gr, sheet, sw } from "../core/ui.js";
import { S, loadState, recomputeTarget, targetLufs } from "../state.js";
import { pollSoon } from "../jobs.js";
import { addFolder } from "./music.js";
import { checkNow, chooseFile, installLatest } from "./updates.js";
import { go } from "../library/sidebar.js";
import { performSettings } from "../perform/settings.js";

const btn = (label, onclick, extra = {}) => h("button", { class: "btn sm", onclick, ...extra }, label);

// Labs: experiments that are off unless you turn them on
function labsGroup(set) {
  const box = h("div", { class: "group" });
  const draw = () => box.replaceChildren(...labs(S.settings, set, draw));
  draw();
  return box;
}

function labs(st, set, redraw) {
  const on = st.labs_soulseek === "1", own = st.slsk_mode === "external";
  const rows = [gr("Soulseek downloads", "Adds a Downloads tab: search Soulseek, and finished tracks join your library. Only download what you're allowed to",
    sw("setSlsk", on, safe(async (e) => { await set("labs_soulseek")(e); if (!e.target.checked && S.view.kind === "downloads") go({ kind: "all" }); redraw(); })))];
  if (!on) return rows;
  const status = h("small", {}, "");
  const show = async () => {  // follow slskd while it downloads, starts and signs in
    if (!status.isConnected) return;
    const r = await api("slsk").catch((e) => ({ state: "error", error: e.message }));
    status.textContent = r.state === "installing" ? `Getting slskd, the Soulseek client: ${Math.round((r.progress || 0) * 100)}%`
      : r.state === "starting" ? "Starting Soulseek…"
      : r.state === "running" ? (r.logged_in ? `Signed in to Soulseek as ${r.user}` : r.connecting ? "Signing in to Soulseek…" : "Not signed in. Check your username and password")
      : r.state === "error" ? r.error.replace(/^\w+Error: /, "")
      : own ? "Point Crate at your slskd and press Test" : "Crate runs slskd for you. Sign in with your Soulseek account";
    if (["installing", "starting"].includes(r.state) || r.connecting) setTimeout(show, 800);
  };
  rows.push(gr("Soulseek client", "Built in: Crate fetches slskd (open source) the first time and runs it while Crate is open. Or use an slskd you already run",
    h("select", { onchange: safe(async (e) => { await set("slsk_mode")(e); redraw(); }) },
      h("option", { value: "builtin", selected: !own }, "Built in"), h("option", { value: "external", selected: own }, "My own slskd"))));
  if (own) {
    rows.push(gr("slskd address", null, h("input", { class: "field", value: st.slsk_url, style: "width:240px", onchange: set("slsk_url") })),
      gr("slskd API key", status, h("div", { style: "display:flex;gap:6px" }, h("input", { class: "field", type: "password", value: st.slsk_key, style: "width:180px", onchange: set("slsk_key") }),
        btn("Test", show))));
  } else {
    const user = h("input", { class: "field", value: st.slsk_user, placeholder: "Username", style: "width:150px", autocomplete: "off" });
    const pass = h("input", { class: "field", type: "password", placeholder: st.slsk_has_pass ? "Saved" : "Password", style: "width:150px", autocomplete: "new-password" });
    const connect = btn("Connect", safe(async () => {
      if (!user.value.trim() || (!pass.value && !st.slsk_has_pass)) { status.textContent = "Enter your Soulseek username and password"; return; }
      await api("slsk/connect", { slsk_user: user.value, slsk_pass: pass.value }); pass.value = ""; pass.placeholder = "Saved";
      S.settings.slsk_user = user.value.trim(); S.settings.slsk_has_pass = true;
      setTimeout(show, 300);
    }), { class: "btn sm primary" });
    rows.push(gr("Soulseek account", status, h("div", { style: "display:flex;gap:6px" }, user, pass, connect)),
      gr("Save downloads to", "Finished tracks land here and join your library", h("input", { class: "field", value: st.slsk_dir, style: "width:240px", onchange: set("slsk_dir") })));
  }
  setTimeout(show, 0);
  return rows;
}

// Updates: Crate checks by itself; this answers "am I up to date?" on the spot
function updatesRow() {
  const status = h("small", {}, S.state.update ? `Crate ${S.state.update.version} is available` : "Crate checks GitHub when it opens, and every few hours");
  const install = h("button", { class: "btn sm primary", onclick: installLatest, hidden: !S.state.update }, S.state.update ? `Update to ${S.state.update.version}` : "Update");
  const check = btn("Check for updates", async () => {
    check.disabled = true; status.textContent = "Checking…";
    try { status.textContent = await checkNow(); } catch (e) { status.textContent = e.message.replace(/^\w+Error: /, ""); }
    check.disabled = false;
    install.hidden = !S.state.update; if (S.state.update) install.textContent = `Update to ${S.state.update.version}`;
  });
  return gr("Updates", status, h("div", { style: "display:flex;gap:6px" }, install, check, btn("Install from file", chooseFile)));
}

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
    h("div", { class: "glabel" }, "Labs"),
    labsGroup(set),
    h("div", { class: "glabel" }, "About"),
    h("div", { class: "group" }, gr(`Crate ${S.state.version}`, `Analysis runs on ${S.state.workers} CPU thread${S.state.workers === 1 ? "" : "s"} at once.`, h("span")),
      updatesRow()),
  ], actions: [{ label: "Done", default: true, result: true }] });
}
