// Timeline view: a bar ruler, one lane per track with its clips drawn on a canvas, and the
// track headers to the right of the lanes; under a spare lane, the returns and Main, as in Ableton. Drag clips to move them (snapped to the grid), drag
// a clip's right edge to lengthen it, click the ruler or an empty lane to set where play starts.
import { h, mount, sizeOf, watchSize } from "../core/dom.js";
import { safe } from "../core/api.js";
import { vu } from "../perform/controls.js";
import { studio, srcKey } from "./engine.js";
import { P, addDevice, addTrack, checkpoint, drag, edit, keyOf, makeClip, redraw, save, trackById } from "./set.js";
import { selectable, stripHead, stripVol, trackToggles } from "./clips.js";

const LANE = 68, EDGE = 6, BAR = 4;
const strips = () => [...P.set.returns, P.set.main];  // the rows under the tracks and the spare lane
const T = { zoom: 10, x: 0, marker: 0, el: null, ruler: null, lanes: null, drawn: "" };  // zoom: px per beat; x: first beat in view

export function renderTimeline(el, W) {
  T.el = el;
  T.ruler = watchSize(h("canvas", { class: "pt-ruler", "data-help": "<b>Bars</b>  Click to set where play starts" }));
  T.lanes = watchSize(h("canvas", { class: "pt-lanes", "data-help": "<b>Timeline</b>  Drag clips to move them, their right edge to lengthen. Ctrl+scroll zooms, Shift+scroll moves along" }));
  mount(el,
    T.ruler, h("div", { class: "pt-corner" }),
    h("div", { class: "pt-scroll" }, T.lanes,
      h("div", { class: "pt-heads" },
        ...P.set.tracks.map((t) => selectable(W, t.id, h("div", { class: "pt-head", style: `--c:${t.colour}` },
          stripHead(t), h("div", { class: "pt-hrow" }, ...trackToggles(W, t), stripVol(W, t)), vu(W, () => studio.track(t).meter())))),
        h("div", { class: "pt-spare" }),
        ...strips().map((o) => selectable(W, keyOf(o), h("div", { class: "pt-head pt-strip", style: `--c:${o.colour || "#55555c"}` },
          stripHead(o), h("div", { class: "pt-hrow" }, stripVol(W, o)), vu(W, () => studio.stripOf(o).meter())))))),
    h("div", { class: "pt-foot" }, h("span", { class: "pt-grid" })));
  T.lanes.style.height = `${(P.set.tracks.length + 1 + strips().length) * LANE}px`;
  wire();
  T.drawn = "";
}

// ---- geometry
const snapStep = () => (T.zoom >= 28 ? 1 : T.zoom >= 5 ? BAR : BAR * 4);
const snap = (b, step = snapStep()) => Math.round(b / step) * step;
const beatAt = (px) => T.x + px / T.zoom;
const laneOf = (a) => P.set.tracks.findIndex((t) => t.id === a.track);
function hit(x, y) {
  const lane = Math.floor(y / LANE), b = beatAt(x);
  for (const a of P.set.arrangement) {
    if (laneOf(a) === lane && b >= a.start && b <= a.start + a.length) return { a, edge: (a.start + a.length - b) * T.zoom < EDGE };
  }
  return null;
}
const local = (e) => { const r = e.currentTarget.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

function setMarker(b) { T.marker = Math.max(0, b); if (studio.song) studio.playSong(T.marker); T.drawn = ""; }
export const marker = () => T.marker;

function wire() {
  const L = T.lanes;
  L.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const [x, y] = local(e), got = hit(x, y);
    if (!got) { P.item = null; setMarker(snap(beatAt(x))); return; }
    P.item = got.a; L.setPointerCapture(e.pointerId);
    const a = got.a, from = { start: a.start, length: a.length, x, y }, step = e.altKey ? 1 / 4 : snapStep();
    let moved = false;
    const move = (ev) => {
      const [mx, my] = local(ev), d = (mx - from.x) / T.zoom;
      if (!moved && Math.abs(mx - from.x) + Math.abs(my - from.y) < 3) return;
      if (!moved) { moved = true; checkpoint(); }
      if (got.edge) a.length = Math.max(step, snap(from.length + d, step));
      else {
        a.start = Math.max(0, snap(from.start + d, step));
        const t = P.set.tracks[Math.floor(my / LANE)]; if (t) a.track = t.id;
      }
      T.drawn = "";
    };
    const up = () => { L.removeEventListener("pointermove", move); L.removeEventListener("pointerup", up); if (moved) { save(); redraw(); } };
    L.addEventListener("pointermove", move); L.addEventListener("pointerup", up);
    T.drawn = "";
  });
  L.addEventListener("pointermove", (e) => { if (e.buttons) return; const [x, y] = local(e), got = hit(x, y); L.style.cursor = got?.edge ? "ew-resize" : got ? "grab" : ""; });
  T.ruler.addEventListener("pointerdown", (e) => setMarker(snap(beatAt(local(e)[0]))));
  for (const c of [L, T.ruler]) c.addEventListener("wheel", wheel, { passive: false });
  L.addEventListener("dragover", (e) => { if (drag.item && drag.item.kind !== "move") e.preventDefault(); });
  L.addEventListener("drop", safe(async (e) => {
    const item = drag.item;
    if (!item || item.kind === "move") return;
    e.preventDefault();
    const [x, y] = local(e);
    // a track's lane, the spare lane (a new track), or a return's or Main's row (effects only)
    const row = Math.floor(y / LANE), n = P.set.tracks.length, strip = row > n ? strips()[row - n - 1] : null;
    if (item.kind === "device") {
      return edit(() => { const o = strip || P.set.tracks[row] || addTrack("audio"); addDevice(o, item.type); P.sel = keyOf(o); });
    }
    if (strip) return;
    const clip = await makeClip(item), start = Math.max(0, snap(beatAt(x)));
    edit(() => {
      const t = P.set.tracks[row] || addTrack("audio", clip.name);
      const a = { track: t.id, clip, start, length: clip.beats };
      P.set.arrangement.push(a); P.item = a;
    });
  }));
}

function wheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {  // zoom around the pointer
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left, b = beatAt(x);
    T.zoom = Math.min(160, Math.max(1.5, T.zoom * Math.exp(-e.deltaY * 0.0015)));
    T.x = Math.max(0, b - x / T.zoom);
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    T.x = Math.max(0, T.x + (e.deltaX || e.deltaY) / T.zoom);
  } else { T.el.querySelector(".pt-scroll").scrollTop += e.deltaY; return; }
  T.drawn = "";
}

// ---- drawing: only when something moved
export function drawTimeline() {
  if (!T.lanes?.isConnected) return;
  const head = studio.songBeat(), [w] = sizeOf(T.lanes), [, lh] = sizeOf(T.lanes);
  if (head != null) {  // keep the playhead in view
    const px = (head - T.x) * T.zoom;
    if (px > w * 0.9 || px < 0) T.x = Math.max(0, head - w * 0.1 / T.zoom);
  }
  const sig = `${w}|${lh}|${T.x}|${T.zoom}|${head?.toFixed(3)}|${T.marker}|${P.set.arrangement.length}|${studio.decoded.size}`;
  if (sig === T.drawn) return;
  T.drawn = sig;
  drawLanes(T.lanes, head); drawRuler(T.ruler, head);
  T.el.querySelector(".pt-grid").textContent = `Grid ${snapStep() === 1 ? "1 beat" : snapStep() === BAR ? "1 bar" : "4 bars"}`;
}

function canvas(c) {
  const [cw, ch] = sizeOf(c), dpr = devicePixelRatio, w = Math.round(cw * dpr), hh = Math.round(ch * dpr);
  if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, cw, ch);
  return [g, cw, ch];
}

function bars(g, w, top, bottom, strong) {
  const step = snapStep() === BAR * 4 ? BAR * 4 : BAR, first = Math.floor(T.x / step) * step;
  for (let b = first; (b - T.x) * T.zoom < w; b += step) {
    const x = Math.round((b - T.x) * T.zoom) + 0.5;
    g.fillStyle = b % (BAR * 4) === 0 ? strong : "#1a1a1d"; g.fillRect(x, top, 1, bottom - top);
  }
  if (T.zoom >= 28) for (let b = Math.floor(T.x); (b - T.x) * T.zoom < w; b++) if (b % BAR) g.fillRect(Math.round((b - T.x) * T.zoom), top, 1, bottom - top);
}

function drawLanes(c, head) {
  const [g, w, hh] = canvas(c);
  const n = P.set.tracks.length, top = (n + 1) * LANE;  // where the returns and Main begin
  P.set.tracks.forEach((t, i) => { g.fillStyle = i % 2 ? "#111113" : "#0e0e10"; g.fillRect(0, i * LANE, w, LANE); });
  bars(g, w, 0, top, "#2a2a2f");
  g.fillStyle = "#0a0a0c"; g.fillRect(0, top, w, hh - top);
  g.fillStyle = "#000"; for (let i = 1; i <= n + 1 + strips().length; i++) g.fillRect(0, i * LANE - 1, w, 1);
  g.font = "600 10px Bahnschrift, 'Segoe UI', sans-serif"; g.textBaseline = "middle";
  for (const a of P.set.arrangement) {
    const lane = laneOf(a); if (lane < 0) continue;
    const x = (a.start - T.x) * T.zoom, cw = a.length * T.zoom, y = lane * LANE + 1, ch = LANE - 3;
    if (x > w || x + cw < 0) continue;
    const t = trackById(a.track);
    g.fillStyle = t.colour; g.globalAlpha = 0.9; g.fillRect(x, y, cw, ch); g.globalAlpha = 1;
    g.fillStyle = "rgba(0,0,0,.28)"; g.fillRect(x, y, cw, 13);
    wave(g, a, x, y + 14, cw, ch - 15, w);
    if (a.clip.loop) { g.fillStyle = "rgba(0,0,0,.35)"; for (let b = a.clip.beats; b < a.length; b += a.clip.beats) g.fillRect(Math.round(x + b * T.zoom), y, 1, ch); }
    g.save(); g.beginPath(); g.rect(x, y, cw, 13); g.clip(); g.fillStyle = "#0b0b0c"; g.fillText(a.clip.name, Math.max(x, 0) + 4, y + 7); g.restore();
    if (a === P.item) { g.strokeStyle = "#fff"; g.lineWidth = 1; g.strokeRect(x + 0.5, y + 0.5, cw - 1, ch - 1); }
  }
  line(g, T.marker, hh, "rgba(255,159,10,.55)");
  if (head != null) line(g, head, hh, "#ff9f0a");
}

function line(g, beat, hh, colour) { const x = Math.round((beat - T.x) * T.zoom) + 0.5; g.fillStyle = colour; g.fillRect(x - 0.5, 0, 1, hh); }

function drawRuler(c, head) {
  const [g, w, hh] = canvas(c);
  g.fillStyle = "#0e0e10"; g.fillRect(0, 0, w, hh);
  g.font = "500 10px Bahnschrift, 'Segoe UI', sans-serif"; g.textBaseline = "middle";
  const every = T.zoom * BAR < 26 ? (T.zoom * BAR * 4 < 26 ? 16 : 4) : 1;
  for (let bar = Math.floor(T.x / BAR); (bar * BAR - T.x) * T.zoom < w; bar++) {
    if (bar % every) continue;
    const x = Math.round((bar * BAR - T.x) * T.zoom) + 0.5;
    g.fillStyle = "#3a3a40"; g.fillRect(x, hh - 7, 1, 7);
    g.fillStyle = "#9d9da3"; g.fillText(String(bar + 1), x + 3, hh / 2 - 1);
  }
  const m = (T.marker - T.x) * T.zoom;  // the insert marker: where play starts
  g.fillStyle = "#ff9f0a"; g.beginPath(); g.moveTo(m - 5, hh - 7); g.lineTo(m + 5, hh - 7); g.lineTo(m, hh); g.fill();
  if (head != null) { g.fillStyle = "#ff9f0a"; g.fillRect(Math.round((head - T.x) * T.zoom), 0, 1, hh); }
  g.fillStyle = "#000"; g.fillRect(0, hh - 1, w, 1);
}

// a clip's waveform, dark on its colour as Ableton draws it, read from peaks made once per sound
const PEAK = 256, peaks = new Map();
function peaksOf(buf, key) {
  let p = peaks.get(key);
  if (!p) {
    const d = buf.getChannelData(0), n = Math.ceil(d.length / PEAK); p = new Float32Array(n);
    for (let i = 0; i < n; i++) { let m = 0; for (let j = i * PEAK, e = Math.min(d.length, j + PEAK); j < e; j++) { const v = d[j] < 0 ? -d[j] : d[j]; if (v > m) m = v; } p[i] = m; }
    peaks.set(key, p);
  }
  return p;
}
function wave(g, a, x, y, cw, ch, w) {
  const key = srcKey(a.clip.src), buf = studio.decoded.get(key);
  if (!buf) { studio.load(a.clip.src).catch(() => {}); return; }
  const p = peaksOf(buf, key), c = a.clip, spb = 60 / (c.bpm || studio.tempo()), per = buf.sampleRate / PEAK, mid = y + ch / 2;
  g.fillStyle = "rgba(0,0,0,.6)";
  for (let px = Math.max(0, Math.floor(x)); px < Math.min(w, x + cw); px++) {
    let b = (px - x) / T.zoom; if (c.loop) b %= c.beats; else if (b > c.beats) break;
    const v = p[Math.floor(((c.offset || 0) + b * spb) * per)] || 0, hv = Math.max(0.5, v * ch / 2);
    g.fillRect(px, mid - hv, 1, hv * 2);
  }
}
