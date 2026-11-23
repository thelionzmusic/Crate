// Crate's front end starts here: wires the top bar, modes, splitters and keyboard, then loads.
//
//   core/      DOM, API, events, UI primitives, formatting, waveform drawing
//   state.js   library data and the loudness target        jobs.js   background job progress
//   library/   sidebar, track list, special views, preview deck
//   sheets/    dialogs: export, settings, smart playlists, set builder, stores, updates
//   engine/    the audio engine (main thread) and the deck processor (audio thread)
//   perform/   Perform mode: layout, controls, lanes, preferences
//   produce/   Production mode: clip and timeline views, sample browser, the clip engine
import { toast } from "./core/api.js";
import { $, typing } from "./core/dom.js";
import { on } from "./core/bus.js";
import { initHelp, isSheetOpen, splitter } from "./core/ui.js";
import { pref, setPref } from "./core/prefs.js";
import { S, loadNodes, loadState, loadThumbs, loadTracks } from "./state.js";
import { mode } from "./mode.js";
import { startPolling } from "./jobs.js";
import { catchErrors, reportProblem } from "./sheets/report.js";
import * as list from "./library/list.js";
import * as sidebar from "./library/sidebar.js";
import * as preview from "./library/preview.js";
import * as previewView from "./library/previewview.js";
import * as updates from "./sheets/updates.js";
import * as perform from "./perform/index.js";
import * as produce from "./produce/index.js";
import { addFolder, findMoved, importRekordbox, importXml } from "./sheets/music.js";
import { openExport } from "./sheets/export.js";
import { openSettings } from "./sheets/settings.js";
import { undo } from "./core/undo.js";
import { showKeys } from "./sheets/keys.js";
import { fullscreen, initMenubar } from "./menubar.js";

// ---- modes: Library prepares, Perform plays live, Produce makes. Only the visible one draws;
// the decks and clips keep sounding whichever is showing.
const MODES = { library: "#mLib", perform: "#mPerf", produce: "#mProd" };
async function setAppMode(m) {
  if (!MODES[m]) m = "library";
  const app = document.querySelector(".app"), was = mode.perform ? "perform" : mode.produce ? "produce" : "library";
  if (m === was && app.classList.contains("ready")) return;
  mode.perform = m === "perform"; mode.produce = m === "produce"; setPref("mode", m);
  app.classList.toggle("perf", mode.perform); app.classList.toggle("prod", mode.produce);
  document.documentElement.classList.toggle("prod", mode.produce);  // Produce's own palette reaches the menu bar and menus too
  for (const [k, sel] of Object.entries(MODES)) $(sel).classList.toggle("on", k === m);
  if (was === "perform") perform.leave(); else if (was === "produce") produce.leave(); else { preview.audio.pause(); previewView.stop(); }
  if (m === "perform") await perform.enter(); else if (m === "produce") await produce.enter(); else previewView.start();
  if (m !== "produce") requestAnimationFrame(list.relayout);
}

// ---- a track was chosen: onto a deck in Perform, into the preview deck in Library
on("open", ({ id, deck, force }) => {
  if (mode.produce) return;
  if (!mode.perform) return preview.load(id);
  return deck ? perform.loadTo(deck, id, force) : perform.loadFocused(id, force);
});

// ---- keyboard: global shortcuts, then the active mode, then the list
function onKey(e) {
  if (isSheetOpen()) return;
  if (e.ctrlKey && e.key === "f") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (e.ctrlKey && e.key === "n") { e.preventDefault(); sidebar.newNode(0, false); return; }
  if (typing()) { if (e.key === "Escape" || e.key === "Enter") document.activeElement.blur(); return; }
  if (e.key === "F11") { e.preventDefault(); fullscreen(); return; }
  const fkey = { F5: "library", F6: "perform", F7: "produce" }[e.key];
  if (fkey) { e.preventDefault(); setAppMode(fkey); return; }
  if (mode.produce) { if (produce.key(e)) e.preventDefault(); return; }
  if (mode.perform) {
    if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && S.sel.size) { e.preventDefault(); perform.loadTo(e.key === "ArrowLeft" ? "A" : "B", list.firstSelected()); return; }
    if (list.key(e) || perform.key(e)) e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (e.key === "?") { e.preventDefault(); showKeys(); return; }
  if (list.jump(e) || preview.key(e) || list.key(e)) e.preventDefault();
}

function wire() {
  initHelp();
  initMenubar($("#menubar"), {
    setMode: setAppMode, produce: produce.commands, undo, selectAll: list.selectAll, find: () => { $("#q").focus(); $("#q").select(); },
    addFolder, importRekordbox, importXml, findMoved, openExport, openSettings, showKeys, reportProblem,
    newNode: (folder) => sidebar.newNode(0, folder), saveSearch: sidebar.saveSearch, go: sidebar.go,
    playPreview: () => $("#play").click(), checkUpdates: updates.checkNow, updateFromFile: updates.chooseFile,
  });
  $("#mLib").onclick = () => setAppMode("library"); $("#mPerf").onclick = () => setAppMode("perform"); $("#mProd").onclick = () => setAppMode("produce");
  $("#addMusic").onclick = addFolder; $("#importRb").onclick = importRekordbox;
  $("#saveSearch").onclick = sidebar.saveSearch; $("#settingsBtn").onclick = openSettings; $("#exportBtn").onclick = openExport;
  let qt;
  $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => list.search(e.target.value), 60); });
  splitter($("#split"), { cssVar: "--deck", store: "deckH", target: () => $("#detail"), min: 230, reserve: 280, onResize: () => { previewView.resize(); list.renderRows(); } });
  splitter($("#psplit"), { cssVar: "--browse", store: "browseH", target: () => $(".main"), min: 150, reserve: 380, onResize: list.renderRows });
  // files from the desktop: an update .zip installs; music is added by the app, which reads the
  // full paths (crateDropNode: the playlist it landed on). Either way the window mustn't open it.
  addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); window.crateDropNode = 0; } }, true);
  addEventListener("drop", (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (/\.zip$/i.test(f.name)) updates.installFile(f); else if (!window.crateDropNode) toast("Adding to your library. Progress is in the status bar");
  });
  addEventListener("keydown", onKey);
  addEventListener("keyup", (e) => { if (mode.perform && !typing()) perform.keyUp(e); });
  addEventListener("resize", () => { list.relayout(); previewView.resize(); });
  addEventListener("pagehide", () => navigator.sendBeacon("/api/bye"));
}

(async () => {
  wire();
  catchErrors();
  await loadState();
  if (S.state.crashed) setTimeout(() => reportProblem(true), 1500);
  for (const m of [preview, previewView, list, sidebar, updates]) m.init();
  await loadTracks(); await loadNodes(); loadThumbs();
  await setAppMode(pref("mode", "library"));
  document.querySelector(".app").classList.add("ready");
  const last = +(/track=(\d+)/.exec(location.hash) || [])[1] || +pref("deck", 0);
  if (last && S.byId.has(last)) preview.load(last);
  startPolling();
})();
