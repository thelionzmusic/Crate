// MIDI controllers: any controller drives the decks and mixer once its knobs and buttons are
// learned (press Learn, then move the control). Mappings are kept with your preferences.
import { h, mount } from "../core/dom.js";
import { toast } from "../core/api.js";
import { pref, setPref } from "../core/prefs.js";
import { sheet } from "../core/ui.js";
import { engine } from "./index.js";

// what a control can do: a press (buttons) or a 0..1 value (knobs, faders)
const DECK = (id) => [
  [`${id}.play`, `Deck ${id} play`, "press", () => engine.deck(id).togglePlay()],
  [`${id}.cue`, `Deck ${id} cue`, "hold", (down) => (down ? engine.deck(id).cueDown() : engine.deck(id).cueUp())],
  [`${id}.sync`, `Deck ${id} sync`, "press", () => { const d = engine.deck(id); d.setSync(!d.sync); }],
  [`${id}.loop`, `Deck ${id} loop`, "press", () => engine.deck(id).loopToggle()],
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => [`${id}.hot${n}`, `Deck ${id} hot cue ${"ABCDEFGH"[n - 1]}`, "press", () => engine.deck(id).hotCue(n, false)]),
  [`${id}.tempo`, `Deck ${id} tempo`, "value", (v) => engine.deck(id).setTempo(1 - v * 2)],
  ...["fader", "trim", "high", "mid", "low", "filter"].map((k) => [`${id}.${k}`, `Deck ${id} ${k === "fader" ? "channel fader" : k}`, "value", (v) => engine.channel(id).set(k, v)]),
];
const ACTIONS = [...DECK("A"), ...DECK("B"),
  ["xfader", "Crossfader", "value", (v) => engine.set("xfader", v)], ["master", "Master volume", "value", (v) => engine.set("master", v)]];
const byKey = new Map(ACTIONS.map((a) => [a[0], a]));

let map = pref("midiMap", {}), learning = null, access = null;

// "note:0:36" or "cc:0:7": what the controller sent, without the value
function idOf([status, num]) {
  const kind = status >> 4, ch = status & 15;
  return kind === 9 || kind === 8 ? `note:${ch}:${num}` : kind === 11 ? `cc:${ch}:${num}` : null;
}

function onMessage({ data }) {
  const id = idOf(data); if (!id) return;
  const kind = data[0] >> 4, v = data[2] ?? 0, down = kind === 9 && v > 0;
  if (learning) { if (kind === 8 || (kind === 9 && !v)) return; map[learning.key] = id; setPref("midiMap", map); learning.done(id); learning = null; return; }
  if (!engine.decks.length) return;
  for (const [key, mapped] of Object.entries(map)) {
    if (mapped !== id) continue;
    const a = byKey.get(key); if (!a) continue;
    const [, , type, run] = a;
    if (type === "value") run(v / 127);
    else if (type === "hold") run(kind === 11 ? v > 63 : down);
    else if (kind === 11 ? v > 63 : down) run();
  }
}

export async function startMidi() {
  if (access || !navigator.requestMIDIAccess) return !!access;
  try { access = await navigator.requestMIDIAccess(); } catch { return false; }
  const wire = () => { for (const input of access.inputs.values()) input.onmidimessage = onMessage; };
  wire(); access.onstatechange = wire;
  return true;
}

export async function mapSheet() {
  if (!await startMidi()) return toast("No MIDI here: this window can't reach controllers");
  const devices = [...access.inputs.values()].map((i) => i.name).join(", ") || "None plugged in";
  const rows = ACTIONS.map(([key, label]) => {
    const val = h("span", { class: "t3" }, map[key] || "Not mapped");
    const learn = h("button", { class: "btn sm" }, "Learn");
    learn.onclick = () => { learn.textContent = "Move a control…"; learning = { key, done: (id) => { val.textContent = id; learn.textContent = "Learn"; } }; };
    const clear = h("button", { class: "btn sm ghost", onclick: () => { delete map[key]; setPref("midiMap", map); val.textContent = "Not mapped"; } }, "Clear");
    return h("div", { class: "gr" }, h("div", { class: "lbl" }, label, val), h("div", { style: "display:flex;gap:6px" }, learn, clear));
  });
  const body = h("div", { class: "group midi" });
  mount(body, ...rows);
  await sheet({ title: "Map a controller", width: 560, body: [h("p", { class: "t3", style: "margin:0 0 8px" }, `Controllers: ${devices}`), body],
    actions: [{ label: "Done", default: true, result: true }] });
  learning = null;
}
