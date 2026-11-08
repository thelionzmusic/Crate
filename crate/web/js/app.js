// Crate's front end starts here: wires the top bar, modes, splitters and keyboard, then loads.
//
//   core/      DOM, API, events, UI primitives, formatting, waveform drawing
//   state.js   library data and the loudness target        jobs.js   background job progress
//   library/   sidebar, track list, special views, preview deck
//   sheets/    dialogs: export, settings, smart playlists, set builder, stores, updates
//   engine/    the audio engine (main thread) and the deck processor (audio thread)
//   perform/   Perform mode: layout, controls, lanes, preferences
import { $, typing } from "./core/dom.js";
import { on } from "./core/bus.js";
import { initHelp, isSheetOpen, splitter } from "./core/ui.js";
import { pref, setPref } from "./core/prefs.js";
import { S, loadNodes, loadState, loadThumbs, loadTracks } from "./state.js";
import { mode } from "./mode.js";
import { startPolling } from "./jobs.js";
import * as list from "./library/list.js";
import * as sidebar from "./library/sidebar.js";
import * as preview from "./library/preview.js";
import * as previewView from "./library/previewview.js";
import * as updates from "./sheets/updates.js";
import * as perform from "./perform/index.js";
import { addFolder, importRekordbox } from "./sheets/music.js";
import { openExport } from "./sheets/export.js";
import { openSettings } from "./sheets/settings.js";

// ---- modes: Library prepares, Perform plays live. Only the visible one draws.
async function setAppMode(m) {
  const perf = m === "perform";
  if (perf === mode.perform && document.querySelector(".app").classList.contains("ready")) return;
  mode.perform = perf; setPref("mode", m);
  document.querySelector(".app").classList.toggle("perf", perf);
  $("#mLib").classList.toggle("on", !perf); $("#mPerf").classList.toggle("on", perf);
  if (perf) { preview.audio.pause(); previewView.stop(); await perform.enter(); }
  else { perform.leave(); previewView.start(); }
  requestAnimationFrame(list.relayout);
}

// ---- a track was chosen: onto a deck in Perform, into the preview deck in Library
on("open", ({ id, deck, force }) => {
  if (!mode.perform) return preview.load(id);
  return deck ? perform.loadTo(deck, id, force) : perform.loadFocused(id, force);
});

// ---- keyboard: global shortcuts, then the active mode, then the list
function onKey(e) {
  if (isSheetOpen()) return;
  if (e.ctrlKey && e.key === "f") { e.preventDefault(); $("#q").focus(); $("#q").select(); return; }
  if (e.ctrlKey && e.key === "n") { e.preventDefault(); sidebar.newNode(0, false); return; }
  if (typing()) { if (e.key === "Escape" || e.key === "Enter") document.activeElement.blur(); return; }
  if (e.key === "F5" || e.key === "F6") { e.preventDefault(); setAppMode(e.key === "F6" ? "perform" : "library"); return; }
  if (mode.perform) {
    if (e.shiftKey && (e.key === "ArrowLeft" || e.key === "ArrowRight") && S.sel.size) { e.preventDefault(); perform.loadTo(e.key === "ArrowLeft" ? "A" : "B", list.firstSelected()); return; }
    if (list.key(e) || perform.key(e)) e.preventDefault();
    return;
  }
  if (preview.key(e) || list.key(e)) e.preventDefault();
}

function wire() {
  initHelp();
  $("#mLib").onclick = () => setAppMode("library"); $("#mPerf").onclick = () => setAppMode("perform");
  $("#addMusic").onclick = addFolder; $("#importRb").onclick = importRekordbox;
  $("#settingsBtn").onclick = openSettings; $("#exportBtn").onclick = openExport;
  let qt;
  $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => list.search(e.target.value), 60); });
  splitter($("#split"), { cssVar: "--deck", store: "deckH", target: () => $("#detail"), min: 230, reserve: 280, onResize: () => { previewView.resize(); list.renderRows(); } });
  splitter($("#psplit"), { cssVar: "--browse", store: "browseH", target: () => $(".main"), min: 150, reserve: 380, onResize: list.renderRows });
  addEventListener("keydown", onKey);
  addEventListener("keyup", (e) => { if (mode.perform && !typing()) perform.keyUp(e); });
  addEventListener("resize", () => { list.relayout(); previewView.resize(); });
  addEventListener("pagehide", () => navigator.sendBeacon("/api/bye"));
}

(async () => {
  wire();
  await loadState();
  for (const m of [preview, previewView, list, sidebar, updates]) m.init();
  await loadTracks(); await loadNodes(); loadThumbs();
  await setAppMode(pref("mode", "library"));
  document.querySelector(".app").classList.add("ready");
  const last = +(/track=(\d+)/.exec(location.hash) || [])[1] || +pref("deck", 0);
  if (last && S.byId.has(last)) preview.load(last);
  startPolling();
})();
