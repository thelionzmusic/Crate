// Performance preferences (stored per machine) and their section of the Settings sheet.
import { h } from "../core/dom.js";
import { safe } from "../core/api.js";
import { gr } from "../core/ui.js";
import { pref, setPref } from "../core/prefs.js";

export const prefs = Object.assign({ decks: 2, device: "", headphones: "off", mixing: "internal", latency: "low", lock: true }, pref("perf", {}));
const listeners = new Set();
export const onPrefs = (fn) => listeners.add(fn);
export async function setPrefs(changes) {
  Object.assign(prefs, changes); setPref("perf", prefs);
  for (const fn of listeners) await fn(changes);
}

// output devices; their names need one microphone permission in Chromium, asked only when they're hidden
export async function outputs() {
  const list = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  let devs = await list();
  if (devs.length && !devs[0].label) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); devs = await list(); } catch { /* names stay generic */ }
  }
  return devs.map((d, i) => ({ id: d.deviceId === "default" ? "" : d.deviceId, label: d.label || `Output ${i + 1}` }));
}

let measured = null;  // set by the engine once audio is running
export const setMeasuredLatency = (s) => { measured = s; };

export async function performSettings() {
  const change = (k) => safe(async (e) => { await setPrefs({ [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }); });
  const devs = await outputs().catch(() => []), opt = (v, label, cur) => h("option", { value: v, selected: v === cur }, label);
  const decks = h("div", { class: "seg" }, ...[2, 4].map((n) => h("button", { class: "btn sm" + (prefs.decks === n ? " on" : ""),
    onclick: safe(async (e) => { await setPrefs({ decks: n }); e.target.parentElement.querySelectorAll(".btn").forEach((b) => b.classList.toggle("on", b === e.target)); }) }, `${n} decks`)));
  return [
    h("div", { class: "glabel" }, "Performance"),
    h("div", { class: "group" },
      gr("Decks", "Two decks, or four with C and D under A and B", decks),
      gr("Output", "Your controller, mixer or soundcard", h("select", { style: "max-width:260px", onchange: change("device") }, opt("", "System default", prefs.device), ...devs.filter((d) => d.id).map((d) => opt(d.id, d.label, prefs.device)))),
      gr("Mixing", "External sends each deck to its own channel pair (A 1-2, B 3-4...) for a DJM or other hardware mixer",
        h("select", { onchange: change("mixing") }, opt("internal", "Crate's mixer", prefs.mixing), opt("external", "External mixer", prefs.mixing))),
      gr("Headphones", "Channels 3-4 is the usual choice on a controller", h("select", { style: "max-width:260px", onchange: change("headphones") },
        opt("off", "Off", prefs.headphones), opt("34", "Channels 3-4 of the output", prefs.headphones), ...devs.filter((d) => d.id && d.id !== prefs.device).map((d) => opt(d.id, d.label, prefs.headphones)))),
      gr("Latency", `Low feels tighter. Safe avoids dropouts on a busy laptop. Applies next time Crate starts${measured != null ? `. Right now: ${Math.round(measured * 1000)} ms` : ""}`,
        h("select", { onchange: change("latency") }, opt("low", "Low", prefs.latency), opt("safe", "Safe", prefs.latency))),
      gr("Protect playing decks", "Loading onto a deck that's on air needs Shift", h("input", { type: "checkbox", class: "switch", checked: prefs.lock, onchange: change("lock") }))),
  ];
}
