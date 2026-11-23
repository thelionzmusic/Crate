// A strip's mixer controls, shared by the clip view's columns and the timeline's headers:
// activator and solo, sends, pan, the volume box, the fader with its meters, and Audio To.
import { h, sizeOf, watchSize } from "../core/dom.js";
import { menu } from "../core/ui.js";
import { drag as dragBy, knob } from "../perform/controls.js";
import { UNITY, gainOf, studio } from "./engine.js";
import { P, edit, inside, isGroup, mixAll, nameOf, parentOf, remix, routeTo, save, touch } from "./set.js";

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// a toggle that fills when on
export function toggle(W, label, get, flip, cls, help) {
  const el = h("button", { class: `pc-tog ${cls}`, "data-help": help, onpointerdown: (e) => { if (e.button === 0) flip(); } }, label);
  let shown = null;
  W.add(el, () => { const v = get(); if (v !== shown) { shown = v; el.classList.toggle("on", v); } });
  return el;
}

export const trackToggles = (W, t) => [
  toggle(W, String(P.set.tracks.indexOf(t) + 1), () => !t.mute, () => { touch(); t.mute = !t.mute; mixAll(); save(); }, "act", "<b>Track on</b>  Click to mute"),
  toggle(W, "S", () => t.solo, () => { touch(); t.solo = !t.solo; mixAll(); save(); }, "solo", "<b>Solo</b>")];

const setVol = (o) => (v) => { touch(); o.volume = clamp01(v); remix(o); save(); };
export const stripVol = (W, o) => volBox(W, () => o.volume, setVol(o));

export const panKnob = (W, o) => knob(W, "Pan", () => ((o.pan || 0) + 1) / 2,
  (v) => { touch(); o.pan = Math.round((clamp01(v) * 2 - 1) * 50) / 50; remix(o); save(); },
  { size: 24, help: "Drag up or down. Double-click to centre" });

// a post-fader send on a fader's scale: 85% round is 0 dB, fully left is off
export const sendKnob = (W, t, r) => knob(W, r.id, () => t.sends[r.id] ?? 0,
  (v) => { touch(); t.sends[r.id] = clamp01(v); remix(t); save(); },
  { size: 24, bipolar: false, def: 0, help: `Send to ${r.name}, after the fader. Double-click turns it off` });

// the volume in dB, in a box you drag
const dbText = (v) => (v <= 0.001 ? "-inf" : (20 * Math.log10(gainOf(v))).toFixed(1));
function volBox(W, get, set) {
  const el = h("div", { class: "pc-val", "data-help": "<b>Volume</b>  Drag up or down, Shift for fine. Double-click resets" });
  let shown = null;
  W.add(el, () => { const v = get(); if (v !== shown) { shown = v; el.textContent = dbText(v); } });
  dragBy(el, (dy, ev) => set(get() - dy * (ev.shiftKey ? 0.001 : 0.005)), { reset: () => set(UNITY) });
  return el;
}

// ---- the fader: a cap on its groove, the strip's left and right meters and a dB scale, on one
// canvas. Meters and scale follow the fader law, so the cap sits beside the level it lets through.
const SCALE = [0, -6, -12, -24, -48];
const posOf = (db) => UNITY * 10 ** (db / 40);  // the fader position giving this many dB
const PAD = 6, HOLD_MS = 1200, FONT = "500 9px Bahnschrift, 'DIN Alternate', 'Segoe UI', sans-serif";
const ZONES = [[posOf(-12), "#36c9a8"], [UNITY, "#e8c547"], [1, "#ff5a5f"]];  // up to -12 dB, up to 0 dB, over

export function fader(W, o, colour) {
  const c = watchSize(h("canvas", { class: "pc-fader", "data-help": "<b>Volume</b>  Drag up or down, Shift for fine. Double-click resets to 0 dB" }));
  const set = setVol(o), span = () => Math.max(1, sizeOf(c)[1] - 2 * PAD);
  dragBy(c, (dy, ev) => set(o.volume - (dy / span()) * (ev.shiftKey ? 0.2 : 1)), { reset: () => set(UNITY) });
  const hold = [{ v: 0, at: 0 }, { v: 0, at: 0 }];
  let drawn = "";
  return W.add(c, () => {
    const [w, ht] = sizeOf(c); if (!w || !ht) return;
    const now = performance.now(), lv = studio.stripOf(o).levels().map((p) => Math.min(1, UNITY * Math.sqrt(p)));
    lv.forEach((v, i) => { const m = hold[i]; if (v >= m.v || now - m.at > HOLD_MS) { m.v = v; m.at = now; } });
    const y = (v) => Math.round(PAD + (1 - v) * (ht - 2 * PAD)), col = colour();
    const sig = `${w}|${ht}|${y(o.volume)}|${lv.map(y)}|${hold.map((m) => y(m.v))}|${col}`;
    if (sig === drawn) return; drawn = sig;
    const r = devicePixelRatio, W2 = Math.round(w * r), H2 = Math.round(ht * r);
    if (c.width !== W2 || c.height !== H2) { c.width = W2; c.height = H2; }
    const g = c.getContext("2d"); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, w, ht);
    const x0 = Math.round(w / 2) - 26, mx = x0 + 30;
    // the groove, and the scale beside the meters
    g.fillStyle = "#05060f"; g.fillRect(x0 + 11, PAD, 3, ht - 2 * PAD);
    g.font = FONT; g.textBaseline = "middle"; g.fillStyle = "#6e6a96";
    let last = -99;
    for (const db of SCALE) { const ty = y(posOf(db)); if (ty - last >= 10) { g.fillText(String(db), mx + 14, ty); last = ty; } }  // a short fader keeps the labels that fit
    // the meters, each lit zone by zone, with the peak held
    lv.forEach((v, i) => {
      const x = mx + i * 5;
      g.fillStyle = "#080918"; g.fillRect(x, PAD, 4, ht - 2 * PAD);
      let from = 0;
      for (const [to, zc] of ZONES) { const top = Math.min(v, to); if (top > from) { g.fillStyle = zc; g.fillRect(x, y(top), 4, y(from) - y(top)); } from = to; if (v <= to) break; }
      const hv = hold[i].v; if (hv > 0.02) { g.fillStyle = hv > UNITY ? "#ff5a5f" : "#dcd8f5"; g.fillRect(x, y(hv), 4, 1); }
    });
    // the cap: light, with the strip's colour across it
    const cy = y(o.volume);
    g.fillStyle = "#e9e6fb"; g.beginPath(); g.roundRect(x0 + 1, cy - 5, 23, 10, 2); g.fill();
    g.fillStyle = col; g.fillRect(x0 + 4, cy - 0.5, 17, 1.5);
  });
}

// ---- Audio To: Main, or a group to play through. Choosing moves the track into it.
export function audioTo(W, t) {
  const groups = () => P.set.tracks.filter((g) => isGroup(g) && g !== t && !inside(g, t));
  const el = h("button", { class: "pc-io", "data-help": "<b>Audio To</b>  Where this track plays: Main, or a group",
    onclick: (e) => menu(e, [{ label: "Main", run: () => edit(() => routeTo(t, null)) }, ...groups().map((g) => ({ label: nameOf(g), run: () => edit(() => routeTo(t, g)) }))]) });
  let shown = null;
  W.add(el, () => { const v = parentOf(t) ? nameOf(parentOf(t)) : "Main"; if (v !== shown) { shown = v; el.textContent = v; } });
  return el;
}
