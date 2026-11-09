// Performance preferences (stored per machine) and their section of the Settings sheet.
import { h } from "../core/dom.js";
import { safe } from "../core/api.js";
import { gr } from "../core/ui.js";
import { pref, setPref } from "../core/prefs.js";
import { API_NAMES, link } from "../engine/native.js";

export const prefs = Object.assign({
  decks: 2, lock: true, mixing: "internal",
  engine: "web",                                   // "web" (in the page) or "native" (ASIO / WASAPI)
  device: "", headphones: "off", latency: "low",   // browser engine
  api: "asio", nativeDevice: "", rate: 0, buffer: 256, masterOut: 0, phonesOut: -1,  // native engine
}, pref("perf", {}));
const listeners = new Set();
export const onPrefs = (fn) => listeners.add(fn);
export async function setPrefs(changes) {
  Object.assign(prefs, changes); setPref("perf", prefs);
  for (const fn of listeners) await fn(changes);
}

// browser output devices; their names need one microphone permission in Chromium, asked only when they're hidden
export async function outputs() {
  const list = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput");
  let devs = await list();
  if (devs.length && !devs[0].label) {
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach((t) => t.stop()); devs = await list(); } catch { /* names stay generic */ }
  }
  return devs.map((d, i) => ({ id: d.deviceId === "default" ? "" : d.deviceId, label: d.label || `Output ${i + 1}` }));
}

let measured = null, statusOf = null;  // set by Perform once audio is running
export const setMeasuredLatency = (s) => { measured = s; };
export const setStatusSource = (fn) => { statusOf = fn; };

const opt = (v, label, cur) => h("option", { value: v, selected: String(v) === String(cur) }, label);
const pairs = (n) => Array.from({ length: Math.floor(n / 2) }, (_, i) => [i * 2, `${i * 2 + 1}-${i * 2 + 2}`]);

export async function performSettings() {
  const box = h("div", { class: "group" });
  const draw = async () => box.replaceChildren(...(await rows(draw)));
  await draw();
  return [h("div", { class: "glabel" }, "Performance"), box];
}

async function rows(redraw) {
  // native choices change what else can be picked (a device's outputs), so those redraw the section
  const change = (k, again = false) => safe(async (e) => {
    const t = e.target, v = t.type === "checkbox" ? t.checked : t.dataset.num ? +t.value : t.value;
    await setPrefs({ [k]: v });
    if (again) await redraw();
  });
  const decks = h("div", { class: "seg" }, ...[2, 4].map((n) => h("button", { class: "btn sm" + (prefs.decks === n ? " on" : ""),
    onclick: safe(async (e) => { await setPrefs({ decks: n }); e.target.parentElement.querySelectorAll(".btn").forEach((b) => b.classList.toggle("on", b === e.target)); }) }, `${n} decks`)));
  const out = [
    gr("Decks", "Two decks, or four with C and D under A and B", decks),
    gr("Audio engine", "Native runs Crate's own engine on ASIO or WASAPI: the lowest latency, and it keeps playing smoothly while the window is busy",
      h("select", { onchange: change("engine", true) }, opt("web", "Built-in (browser)", prefs.engine), opt("native", "Native (ASIO / WASAPI)", prefs.engine))),
  ];
  out.push(...(prefs.engine === "native" ? await nativeRows(change) : await webRows(change)));
  out.push(
    gr("Mixing", "External sends each deck to its own channel pair (A 1-2, B 3-4...) for a DJM or other hardware mixer",
      h("select", { onchange: change("mixing", true) }, opt("internal", "Crate's mixer", prefs.mixing), opt("external", "External mixer", prefs.mixing))),
    gr("Protect playing decks", "Loading onto a deck that's on air needs Shift", h("input", { type: "checkbox", class: "switch", checked: prefs.lock, onchange: change("lock") })));
  return out;
}

async function webRows(change) {
  const devs = await outputs().catch(() => []);
  return [
    gr("Output", "Your controller, mixer or soundcard", h("select", { style: "max-width:260px", onchange: change("device") }, opt("", "System default", prefs.device), ...devs.filter((d) => d.id).map((d) => opt(d.id, d.label, prefs.device)))),
    prefs.mixing === "external" ? null : gr("Headphones", "Channels 3-4 is the usual choice on a controller", h("select", { style: "max-width:260px", onchange: change("headphones") },
      opt("off", "Off", prefs.headphones), opt("34", "Channels 3-4 of the output", prefs.headphones), ...devs.filter((d) => d.id && d.id !== prefs.device).map((d) => opt(d.id, d.label, prefs.headphones)))),
    gr("Latency", `Low feels tighter. Safe avoids dropouts on a busy laptop. Applies next time Crate starts${measured != null ? `. Right now: ${Math.round(measured * 1000)} ms` : ""}`,
      h("select", { onchange: change("latency") }, opt("low", "Low", prefs.latency), opt("safe", "Safe", prefs.latency))),
  ].filter(Boolean);
}

async function nativeRows(change) {
  let apis, devs;
  try {
    apis = await link.apis();
    const api = apis.includes(prefs.api) ? prefs.api : apis[0];
    devs = await link.devices(api);
    if (api !== prefs.api) prefs.api = api;
  } catch (e) {
    return [gr("Native engine", e.message, h("span", { class: "t3" }, "Not available"))];
  }
  const dev = devs.find((d) => d.name === prefs.nativeDevice) || devs.find((d) => d.default) || devs[0];
  const n = dev ? dev.outputs : 2, st = statusOf?.();
  const live = st && st.rate ? `Running at ${st.rate / 1000} kHz, ${st.buffer} samples: ${(st.latency * 1000).toFixed(1)} ms to the speakers, ${Math.round(st.load * 100)}% of the audio thread${st.xruns ? `, ${st.xruns} dropouts so far` : ""}` : "";
  const num = { "data-num": "1" };
  return [
    gr("Driver", "ASIO is the low-latency choice for audio interfaces and controllers. WASAPI works with any Windows output",
      h("select", { onchange: change("api", true) }, ...apis.map((a) => opt(a, API_NAMES[a] || a, prefs.api)))),
    gr("Output", devs.length ? "Your controller, mixer or audio interface" : "No outputs found for this driver. Is it plugged in?",
      h("select", { style: "max-width:260px", onchange: change("nativeDevice", true) }, ...devs.map((d) => opt(d.name, d.name, dev ? dev.name : "")))),
    gr("Buffer size", live || "Smaller is tighter. Go up a step if you hear crackles",
      h("select", { ...num, onchange: change("buffer", true) }, ...[64, 128, 256, 512, 1024].map((b) => opt(b, `${b} samples`, prefs.buffer)))),
    gr("Sample rate", "Auto uses the device's own rate",
      h("select", { ...num, onchange: change("rate", true) }, opt(0, "Auto", prefs.rate), ...(dev ? dev.rates : []).filter((r) => r >= 44100 && r <= 96000).map((r) => opt(r, `${r / 1000} kHz`, prefs.rate)))),
    prefs.mixing === "external" ? null : gr("Master out", "The outputs your speakers or booth are on",
      h("select", { ...num, onchange: change("masterOut", true) }, ...pairs(n).map(([v, l]) => opt(v, l, prefs.masterOut)))),
    prefs.mixing === "external" ? null : gr("Headphones", "The outputs your headphones are on, often 3-4 on a controller",
      h("select", { ...num, onchange: change("phonesOut", true) }, opt(-1, "Off", prefs.phonesOut), ...pairs(n).filter(([v]) => v !== prefs.masterOut).map(([v, l]) => opt(v, l, prefs.phonesOut)))),
  ].filter(Boolean);
}
