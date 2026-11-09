// Drawing and pointer handling for the preview deck: overview, phrase lane, bar ruler and
// the zoomed waveform. It redraws only when something visible changed, and stops entirely
// while the Library is hidden, so it never competes with the performance engine.
import { $ } from "../core/dom.js";
import { on } from "../core/bus.js";
import { pref, setPref } from "../core/prefs.js";
import { PHRASE, cueColor, fmtTime } from "../core/format.js";
import { TileStrip, overview, tempoMarks } from "../core/wave.js";
import { CanvasText } from "../core/canvastext.js";
import { S } from "../state.js";
import { audio, beatTimes, deck, deleteCue, dur, pos, seek, snap } from "./preview.js";

const FPS = 150;
const C = {};  // canvases by id
let clock = null;  // the Position readout in the top bar
const tiles = new TileStrip(32);
let mode = "rgb", ovImg = null, ovFor = null, running = false, raf = 0, last = "", font = "", lastClick = -1, clickCtx = null;

export function setWaveMode(m) {
  mode = m === "3band" ? "3band" : "rgb"; setPref("waveMode", mode);
  $("#wRGB").classList.toggle("on", mode === "rgb"); $("#w3").classList.toggle("on", mode !== "rgb");
  buildOverview(); invalidate();
}
function size() {
  for (const c of Object.values(C)) { const r = c.getBoundingClientRect(); c.width = Math.max(1, Math.round(r.width * devicePixelRatio)); c.height = Math.max(1, Math.round(r.height * devicePixelRatio)); }
  tiles.clear(); buildOverview(); invalidate();
}
function buildOverview() { const o = C.overview; ovImg = o && deck.wave && o.width > 1 ? overview(deck.wave, o.width, o.height, mode) : null; ovFor = deck.id; }
const invalidate = () => { last = ""; };

// start/stop with the Library view
export function start() { if (running) return; running = true; size(); raf = requestAnimationFrame(frame); }
export function stop() { running = false; cancelAnimationFrame(raf); }

function frame() {
  if (!running) return;
  raf = requestAnimationFrame(frame);
  if (!deck.t) return;
  const now = pos(), sig = `${now}|${deck.version}|${deck.zoom}|${mode}|${C.wave.width}`;
  if (sig === last) return;  // nothing moved: skip the frame
  last = sig;
  draw(now);
  if (!audio.paused && $("#metro").classList.contains("on")) metronome(now);
}

function draw(now) {
  const D = dur(), dpr = devicePixelRatio, t = deck.t;
  font ||= getComputedStyle(document.body).fontFamily;
  const f = (px, w = 600) => `${w} ${px * dpr}px ${font}`;

  // overview with the zoom window
  const o = C.overview, oc = o.getContext("2d"), opx = now / D * o.width;
  oc.clearRect(0, 0, o.width, o.height); if (ovImg) oc.drawImage(ovImg, 0, 0);
  const v0 = (now - deck.zoom / 2) / D * o.width, v1 = (now + deck.zoom / 2) / D * o.width;
  oc.save(); oc.globalCompositeOperation = "source-atop"; oc.fillStyle = "rgba(6,7,10,.6)"; oc.fillRect(0, 0, opx, o.height); oc.restore();
  oc.fillStyle = "rgba(255,255,255,.07)"; oc.fillRect(v0, 0, Math.max(2 * dpr, v1 - v0), o.height);
  oc.strokeStyle = "rgba(255,255,255,.35)"; oc.lineWidth = dpr; oc.strokeRect(v0 + dpr / 2, dpr / 2, Math.max(dpr, v1 - v0 - dpr), o.height - dpr);
  for (const c of deck.cues) { oc.fillStyle = cueColor(c); oc.fillRect(c.start_ms / 1000 / D * o.width, 0, dpr * 1.5, o.height * (c.slot ? 1 : 0.4)); }
  tempoMarks(oc, t.tempos, D, o.width, o.height, font);
  oc.fillStyle = "#ff9f0a"; oc.fillRect(opx - dpr, 0, 2 * dpr, o.height);

  // phrase lane with the vocal strip under it
  const ln = C.lane, lc = ln.getContext("2d"), LH = ln.height, PH = LH - 6 * dpr;
  lc.clearRect(0, 0, ln.width, LH); lc.font = f(10.5); lc.textBaseline = "middle";
  for (const p of deck.phrases) {
    const x0 = p.start_ms / 1000 / D * ln.width, x1 = p.end_ms / 1000 / D * ln.width, active = now * 1000 >= p.start_ms && now * 1000 < p.end_ms;
    lc.globalAlpha = active ? 1 : 0.6; lc.fillStyle = PHRASE[p.label] || "#555"; lc.beginPath(); lc.rect(x0 + dpr, 0, Math.max(1, x1 - x0 - 2 * dpr), PH); lc.fill();
    if (active) { lc.save(); lc.clip(); lc.fillStyle = "rgba(255,255,255,.16)"; lc.fillRect(x0, 0, now / D * ln.width - x0, PH); lc.restore(); }
    lc.globalAlpha = 1;
    if (x1 - x0 > 46 * dpr) { lc.fillStyle = "rgba(255,255,255,.94)"; lc.fillText(`${p.label}  ${p.bars}`, x0 + 6 * dpr, PH / 2, x1 - x0 - 10 * dpr); }
  }
  lc.fillStyle = "rgba(244,239,228,.55)";
  for (const [a, b] of deck.vocals) lc.fillRect(a / 1000 / D * ln.width, LH - 3.5 * dpr, Math.max(dpr, (b - a) / 1000 / D * ln.width), 2.5 * dpr);

  // zoomed waveform
  const d = C.wave, dc = d.getContext("2d"), W = d.width, H = d.height, span = deck.zoom, left = now - span / 2, pps = W / span, w = deck.wave, n = w ? w.length / 3 : 0;
  dc.clearRect(0, 0, W, H);
  if (n) tiles.draw(dc, w, FPS, deck.id, left, 0, W, H, pps, 1, mode);
  dc.save(); dc.globalCompositeOperation = "source-atop"; dc.fillStyle = "rgba(8,8,10,.4)"; dc.fillRect(0, 0, W / 2, H); dc.restore();  // played side dimmed

  // ruler: bars and mix points; beat ticks on the waveform
  const ru = C.ruler, rc = ru.getContext("2d"); rc.clearRect(0, 0, ru.width, ru.height); rc.font = f(10, 500); rc.textBaseline = "middle";
  const db = t.downbeat || 0, every = span > 40 ? 8 : span > 20 ? 4 : 1;
  for (const [s, i] of beatTimes(left, left + span)) {
    const x = Math.round((s - left) * pps), inBar = ((i - db) % 4 + 4) % 4, bar = Math.floor((i - db) / 4) + 1;
    if (inBar === 0) {
      dc.fillStyle = "rgba(255,255,255,.45)"; dc.fillRect(x, 0, dpr, H); rc.fillStyle = "#5b5b63"; rc.fillRect(x, ru.height * 0.5, dpr, ru.height * 0.5);
      if (bar > 0 && (bar - 1) % every === 0) { rc.fillStyle = "#b9b9c0"; rc.fillText(String(bar), x + 4 * dpr, ru.height * 0.45); }
    } else if (span <= 30) { dc.fillStyle = "rgba(255,255,255,.13)"; dc.fillRect(x, 0, dpr, H * 0.08); dc.fillRect(x, H * 0.92, dpr, H * 0.08); }
  }
  rc.font = f(9.5, 700);
  for (const [ms, lbl] of [[t.mix_in_ms, "IN"], [t.mix_out_ms, "OUT"]]) {
    if (ms == null) continue; const x = (ms / 1000 - left) * pps; if (x < -40 || x > ru.width + 40) continue;
    const tw = rc.measureText(lbl).width + 8 * dpr;
    rc.fillStyle = "#3a9a62"; rc.fillRect(x, dpr, tw, ru.height - 2 * dpr); rc.fillStyle = "#0f1012"; rc.fillText(lbl, x + 4 * dpr, ru.height / 2 + 0.5);
  }

  // cues
  dc.font = f(10.5, 700); dc.textBaseline = "middle"; dc.save();
  for (const c of deck.cues) {
    const x = (c.start_ms / 1000 - left) * pps; if (x < -140 * dpr || x > W + 40) continue;
    const col = cueColor(c), s = 15 * dpr;
    if (c.end_ms > 0) { dc.fillStyle = `${col}30`; dc.fillRect(x, 0, (c.end_ms - c.start_ms) / 1000 * pps, H); }
    dc.fillStyle = col; dc.fillRect(x, 0, 1.5 * dpr, H);
    if (c.slot) {
      const label = "ABCDEFGH"[c.slot - 1] + (c.name ? `  ${c.name}` : ""), tw = dc.measureText(label).width + 10 * dpr;
      dc.fillRect(x, 0, tw, s); dc.fillStyle = "#111"; dc.fillText(label, x + 5 * dpr, s / 2 + 0.5);
    } else {
      dc.beginPath(); dc.moveTo(x, H); dc.lineTo(x + 8 * dpr, H); dc.lineTo(x, H - 8 * dpr); dc.fill();
      if (c.name && pps > 40 * dpr) { dc.font = f(10, 600); dc.fillStyle = "rgba(255,106,94,.9)"; dc.fillText(c.name, x + 10 * dpr, H - 7 * dpr); dc.font = f(10.5, 700); }
    }
  }
  dc.restore();
  // playhead
  dc.save(); dc.fillStyle = "#ff9f0a"; dc.fillRect(W / 2 - dpr, 0, 2 * dpr, H);
  for (const [y, sgn] of [[0, 1], [H, -1]]) { dc.beginPath(); dc.moveTo(W / 2 - 5 * dpr, y); dc.lineTo(W / 2 + 5 * dpr, y); dc.lineTo(W / 2, y + sgn * 6 * dpr); dc.closePath(); dc.fill(); }
  dc.restore();
  clock.set(`${fmtTime(now)}.${Math.floor((now % 1) * 10)}`);
}

function metronome(now) {
  const beat = beatTimes(now - 0.03, now + 0.01).pop(), db = deck.t.downbeat || 0;
  if (!beat || beat[1] === lastClick) return;
  lastClick = beat[1];
  const accent = ((beat[1] - db) % 4 + 4) % 4 === 0;
  clickCtx ||= new AudioContext();
  const a = clickCtx, o = a.createOscillator(), g = a.createGain();
  o.frequency.value = accent ? 1760 : 1180; g.gain.setValueAtTime(0.25, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.05);
  o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.06);
}

function bindPointer() {
  const at = (e, el) => { const r = el.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
  C.overview.addEventListener("pointerdown", (e) => seek(at(e, C.overview) * dur()));
  C.lane.addEventListener("pointerdown", (e) => { if (!deck.t) return; const ms = at(e, C.lane) * dur() * 1000, p = deck.phrases.find((x) => ms >= x.start_ms && ms < x.end_ms); seek(p ? p.start_ms / 1000 : ms / 1000); });
  C.ruler.addEventListener("pointerdown", (e) => seek(snap(pos() - deck.zoom / 2 + at(e, C.ruler) * deck.zoom)));
  // the waveform: 1:1 drag, flick to coast, wheel to zoom
  const det = C.wave; let drag = null, coast = 0;
  det.addEventListener("pointerdown", (e) => {
    if (!deck.t) return;
    const r = det.getBoundingClientRect(), s = pos() - deck.zoom / 2 + (e.clientX - r.left) / r.width * deck.zoom;
    const hit = deck.cues.find((c) => Math.abs((c.start_ms / 1000 - s) / deck.zoom * r.width) < 6);
    if (hit && e.shiftKey) { deleteCue(hit); return; }
    cancelAnimationFrame(coast); det.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, t: pos(), playing: !audio.paused, hist: [[e.clientX, performance.now()]] }; audio.pause(); det.style.cursor = "grabbing";
  });
  det.addEventListener("pointermove", (e) => {
    if (!drag) return; const r = det.getBoundingClientRect(); seek(drag.t - (e.clientX - drag.x) / r.width * deck.zoom);
    drag.hist.push([e.clientX, performance.now()]); if (drag.hist.length > 5) drag.hist.shift();
  });
  const end = () => {
    if (!drag) return; det.style.cursor = "";
    const [x0, t0] = drag.hist[0], [x1, t1] = drag.hist[drag.hist.length - 1], r = det.getBoundingClientRect();
    let v = t1 > t0 ? -(x1 - x0) / (t1 - t0) * 1000 / r.width * deck.zoom : 0; const resume = drag.playing; drag = null;
    if (resume) { audio.play(); return; }
    let prev = performance.now();
    const step = (now) => { const dt = (now - prev) / 1000; prev = now; v *= Math.pow(0.996, dt * 1000); if (Math.abs(v) < 0.05) return; seek(pos() + v * dt); coast = requestAnimationFrame(step); };
    if (Math.abs(v) > 0.5) coast = requestAnimationFrame(step);
  };
  det.addEventListener("pointerup", end); det.addEventListener("pointercancel", end);
  det.addEventListener("wheel", (e) => { e.preventDefault(); deck.zoom = Math.min(90, Math.max(2, deck.zoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15))); }, { passive: false });
}

export function init() {
  for (const id of ["ruler", "lane", "overview", "wave"]) C[id] = $(`#${id}`);
  clock = new CanvasText($("#rPos"));
  $("#wRGB").onclick = () => setWaveMode("rgb"); $("#w3").onclick = () => setWaveMode("3band");
  setWaveMode(pref("waveMode", S.settings.waveform || "rgb"));
  bindPointer();
  on("preview", () => { if (ovFor !== deck.id) buildOverview(); invalidate(); });
}
export const resize = () => { if (running) size(); };
