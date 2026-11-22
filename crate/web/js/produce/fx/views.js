// Device displays: what a device is doing, drawn on a canvas only when something changed, and
// for the EQ, filter, compressor and gate something to grab. Curves come from the live audio
// nodes themselves, so what's drawn is exactly what's heard.
import { h, sizeOf, watchSize } from "../../core/dom.js";
import { amp, clamp } from "../../core/num.js";
import { studio } from "../engine.js";
import { save, setParam, touch } from "../set.js";
import { DEVICES, SHAPES, eqHasGain } from "./devices.js";
import { valueOf } from "./params.js";

const INK = { grid: "rgba(255,255,255,.055)", zero: "rgba(255,255,255,.16)", label: "#5f5f67", curve: "#ff9f0a", fill: "rgba(255,159,10,.13)", spec: "rgba(150,160,180,.2)", hot: "#ff5b4f" };
export const BAND_COLOURS = ["#ff6a3d", "#ff9f0a", "#d6c84a", "#5ccf6a", "#3fb8af", "#4fa3ff", "#7c8cff", "#f05d8f"];
const LABEL = "500 9px system-ui, sans-serif";
const SETTLE_MS = 160;  // parameters glide; keep redrawing until the nodes have arrived

// A canvas that repaints when sig() changes, or every frame while live() holds
export function surface(W, cls, sig, paint, live = () => false) {
  const c = watchSize(h("canvas", { class: `dv ${cls}` }));
  let drawn = "", base = "", moved = 0;
  W.add(c, () => {
    const [cw, ch] = sizeOf(c);
    if (!cw || !ch) return;
    const now = performance.now(), b = `${cw}|${ch}|${sig()}`;
    if (b !== base) { base = b; moved = now; }
    const s = live() || now - moved < SETTLE_MS ? `${b}|${now}` : b;
    if (s === drawn) return;
    drawn = s;
    const k = devicePixelRatio || 1, w = Math.round(cw * k), H = Math.round(ch * k);
    if (c.width !== w || c.height !== H) { c.width = w; c.height = H; }
    const g = c.getContext("2d");
    g.setTransform(k, 0, 0, k, 0, 0); g.clearRect(0, 0, cw, ch);
    paint(g, cw, ch);
  });
  return c;
}

// pointer position inside the canvas, and a drag that ends where it started
const at = (c, e) => { const r = c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
function dragOn(c, start) {
  c.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const move = start(...at(c, e), e);
    if (!move) return;
    e.preventDefault(); c.setPointerCapture(e.pointerId);
    const m = (ev) => move(...at(c, ev), ev);
    const up = () => { c.removeEventListener("pointermove", m); c.removeEventListener("pointerup", up); };
    c.addEventListener("pointermove", m); c.addEventListener("pointerup", up);
  });
}

const sigOf = (d) => JSON.stringify(d.params) + (d.on === false ? "off" : "") + (d.band || "");
const vals = (d) => { const o = {}; for (const p of DEVICES[d.type].params) o[p.k] = valueOf(p, d.params); return o; };
const put = (o, d, k, v) => setParam(o, d, DEVICES[d.type].byKey[k], v);

// ---- frequency displays -----------------------------------------------------------------
const F0 = 20, F1 = 20000, LF = Math.log(F1 / F0);
const xOfF = (f, w) => Math.log(f / F0) / LF * w;
const fOfX = (x, w) => F0 * Math.exp(x / w * LF);
const FREQS = Float32Array.from({ length: 256 }, (_, i) => F0 * Math.exp(i / 255 * LF));
const MAG = new Float32Array(256), PH = new Float32Array(256);

// the combined magnitude of a set of filters, in dB at each of FREQS
function response(filters, gain = 1) {
  const out = new Float32Array(FREQS.length).fill(gain);
  for (const f of filters) { f.getFrequencyResponse(FREQS, MAG, PH); for (let i = 0; i < out.length; i++) out[i] *= MAG[i]; }
  return out.map((m) => 20 * Math.log10(Math.max(m, 1e-6)));
}

function freqGrid(g, w, H, yOf, dbs) {
  g.font = LABEL; g.textBaseline = "top";
  for (const f of [30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000]) {
    const x = Math.round(xOfF(f, w)) + 0.5, major = f === 100 || f === 1000 || f === 10000;
    g.strokeStyle = major ? INK.zero : INK.grid; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
    if (major && x < w - 18) { g.fillStyle = INK.label; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 3, H - 12); }
  }
  for (const db of dbs) {
    const y = Math.round(yOf(db)) + 0.5;
    g.strokeStyle = db === 0 ? INK.zero : INK.grid; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
    if (db) { g.fillStyle = INK.label; g.fillText(`${db > 0 ? "+" : ""}${db}`, 3, y + 2); }
  }
}

function curvePath(g, w, dbs, yOf) {
  g.beginPath();
  dbs.forEach((db, i) => { const x = xOfF(FREQS[i], w), y = yOf(db); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
}

// the live spectrum behind the EQ curve, while anything is playing
const SPEC = { data: null };
function spectrum(g, w, H, analyser) {
  const n = analyser.frequencyBinCount;
  if (SPEC.data?.length !== n) SPEC.data = new Float32Array(n);
  analyser.getFloatFrequencyData(SPEC.data);
  const nyq = analyser.context.sampleRate / 2;
  g.beginPath(); g.moveTo(0, H);
  for (let x = 0; x <= w; x += 2) {
    const db = SPEC.data[Math.min(n - 1, Math.round(fOfX(x, w) / nyq * n))];
    g.lineTo(x, H - clamp((db + 96) / 84, 0, 1) * H);
  }
  g.lineTo(w, H); g.closePath(); g.fillStyle = INK.spec; g.fill();
}

// ---- EQ Eight ----------------------------------------------------------------------------
function eq(W, o, d) {
  const GMAX = 15, inst = () => studio.device(o, d.id);
  const yOf = (H) => (db) => H / 2 - db / GMAX * (H / 2 - 7);
  const handle = (v, b, w, H) => [xOfF(v[`f${b}`], w), yOf(H)(eqHasGain(v[`t${b}`]) ? v[`g${b}`] : 0)];
  const c = surface(W, "eq", () => sigOf(d), (g, w, H) => {
    const y = yOf(H), v = vals(d), x = inst(), sel = d.band || 3;
    freqGrid(g, w, H, y, [-12, -6, 0, 6, 12]);
    if (x?.analyser && studio.busy) spectrum(g, w, H, x.analyser);  // the browser's analyser; none on the native engine yet
    if (!x) return;
    if (v[`on${sel}`]) {  // the selected band on its own, faint, in its colour
      curvePath(g, w, response(x.bands[sel - 1]), y);
      g.lineTo(w, y(0)); g.lineTo(0, y(0)); g.closePath(); g.fillStyle = `${BAND_COLOURS[sel - 1]}26`; g.fill();
    }
    curvePath(g, w, response(x.bands.flat(), amp(v.out)), y);
    g.strokeStyle = d.on === false ? INK.label : INK.curve; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
    g.font = "600 9px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    for (let b = 1; b <= 8; b++) {
      const [hx, hy] = handle(v, b, w, H), on = v[`on${b}`];
      g.beginPath(); g.arc(hx, hy, 6.5, 0, 2 * Math.PI);
      g.fillStyle = on ? BAND_COLOURS[b - 1] : "#1c1c20"; g.fill();
      g.strokeStyle = b === sel ? "#fff" : on ? "rgba(0,0,0,.6)" : "#4a4a52"; g.lineWidth = b === sel ? 1.5 : 1; g.stroke(); g.lineWidth = 1;
      g.fillStyle = on ? "#0b0b0c" : "#6e6e76"; g.fillText(String(b), hx, hy + 0.5);
    }
    g.textAlign = "start";
  }, () => studio.busy && !!inst());
  const nearest = (x, y) => {
    const [w, H] = sizeOf(c), v = vals(d);
    let best = 0, dist = 13;
    for (let b = 1; b <= 8; b++) { const [hx, hy] = handle(v, b, w, H), dd = Math.hypot(hx - x, hy - y); if (dd < dist) { dist = dd; best = b; } }
    return best;
  };
  dragOn(c, (x0, y0) => {
    const b = nearest(x0, y0);
    if (!b) return null;
    d.band = b; save();
    let lx = x0, ly = y0;
    return (x, y, ev) => {  // moves by the pointer's travel, so grabbing a dot off-centre doesn't jump it
      const [w, H] = sizeOf(c), v = vals(d), fine = ev.shiftKey ? 0.2 : 1, [hx, hy] = handle(v, b, w, H);
      touch();
      put(o, d, `f${b}`, clamp(fOfX(hx + (x - lx) * fine, w), 10, 22000));
      if (eqHasGain(v[`t${b}`])) put(o, d, `g${b}`, clamp((H / 2 - (hy + (y - ly) * fine)) / (H / 2 - 7) * GMAX, -GMAX, GMAX));
      lx = x; ly = y;
    };
  });
  c.addEventListener("dblclick", (e) => { const b = nearest(...at(c, e)); if (b) { touch(); put(o, d, `on${b}`, !vals(d)[`on${b}`]); } });
  c.addEventListener("wheel", (e) => {
    const b = nearest(...at(c, e)) || d.band || 3;
    e.preventDefault(); touch(); d.band = b;
    put(o, d, `q${b}`, clamp(vals(d)[`q${b}`] * Math.exp(-Math.sign(e.deltaY) * 0.08), 0.1, 18));
  }, { passive: false });
  return c;
}

// ---- Auto Filter -------------------------------------------------------------------------
function filter(W, o, d) {
  const RES = DEVICES.filter.byKey.res, inst = () => studio.device(o, d.id);
  const yOf = (H) => (db) => (18 - db) / 66 * H;  // +18 dB at the top, -48 at the bottom
  const resY = (r, H) => H - 8 - Math.log(r / RES.min) / Math.log(RES.max / RES.min) * (H - 16);
  const c = surface(W, "filter", () => sigOf(d), (g, w, H) => {
    const y = yOf(H), v = vals(d), x = inst();
    freqGrid(g, w, H, y, [12, 0, -12, -24, -36]);
    if (!x) return;
    curvePath(g, w, response(x.filters), y);
    g.lineTo(w, H); g.lineTo(0, H); g.closePath(); g.fillStyle = INK.fill; g.fill();
    curvePath(g, w, response(x.filters), y);
    g.strokeStyle = d.on === false ? INK.label : INK.curve; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
    g.beginPath(); g.arc(xOfF(v.freq, w), resY(v.res, H), 5, 0, 2 * Math.PI); g.fillStyle = "#fff"; g.fill();
  }, () => studio.busy && vals(d).lfo > 0);
  dragOn(c, () => (x, y) => {
    const [w, H] = sizeOf(c);
    touch();
    put(o, d, "freq", clamp(fOfX(x, w), 20, 20000));
    put(o, d, "res", clamp(RES.min * (RES.max / RES.min) ** ((H - 8 - y) / (H - 16)), RES.min, RES.max));
  });
  return c;
}

// ---- Compressor: its transfer curve, the threshold to drag, and gain reduction -----------
// gain reduction, falling from the top
function grMeter(g, x0, w, H, gr, range = 24) {
  g.fillStyle = "#121215"; g.fillRect(x0, 0, w, H);
  g.fillStyle = INK.curve; g.fillRect(x0, 0, w, Math.round(clamp(-gr / range, 0, 1) * H));
}
const grText = (gr) => (gr < -0.05 ? gr.toFixed(1) : "0.0");

function comp(W, o, d) {
  const LO = -60, inst = () => studio.device(o, d.id), METER = 14;
  const c = surface(W, "comp", () => `${sigOf(d)}|${(inst()?.meter ?? 0).toFixed(1)}`, (g, w0, H) => {
    const v = vals(d), w = w0 - METER - 4, xOf = (db) => (db - LO) / -LO * w, yOf = (db) => H - (db - LO) / -LO * H;
    g.strokeStyle = INK.grid;
    for (const db of [-48, -36, -24, -12]) { g.beginPath(); g.moveTo(xOf(db) + 0.5, 0); g.lineTo(xOf(db) + 0.5, H); g.moveTo(0, yOf(db) + 0.5); g.lineTo(w, yOf(db) + 0.5); g.stroke(); }
    g.strokeStyle = INK.zero; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, H); g.lineTo(w, 0); g.stroke(); g.setLineDash([]);
    const slope = 1 / v.ratio - 1, knee = v.knee;
    const out = (x) => {
      const over = x - v.threshold;
      return x + (2 * over < -knee ? 0 : knee > 0 && 2 * Math.abs(over) <= knee ? slope * (over + knee / 2) ** 2 / (2 * knee) : slope * over);
    };
    g.beginPath();
    for (let px = 0; px <= w; px++) { const x = LO + px / w * -LO, yy = yOf(out(x)); if (px) g.lineTo(px, yy); else g.moveTo(px, yy); }
    g.strokeStyle = d.on === false ? INK.label : INK.curve; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
    const tx = Math.round(xOf(v.threshold)) + 0.5;
    g.strokeStyle = "rgba(255,255,255,.35)"; g.beginPath(); g.moveTo(tx, 0); g.lineTo(tx, H); g.stroke();
    g.font = LABEL; g.fillStyle = INK.label; g.textBaseline = "top"; g.fillText(`${v.threshold.toFixed(1)} dB`, Math.min(tx + 4, w - 46), 3);
    const gr = inst()?.meter ?? 0;
    grMeter(g, w + 4, METER, H, gr);
    g.textBaseline = "bottom"; g.textAlign = "right"; g.fillText(`GR ${grText(gr)}`, w - 3, H - 2); g.textAlign = "start";
  }, () => studio.busy);
  dragOn(c, () => (x) => { const w = sizeOf(c)[0] - METER - 4; touch(); put(o, d, "threshold", clamp(LO + x / w * -LO, -60, 0)); });
  return c;
}

// ---- Gate: threshold and return on a level scale, and whether it's open -------------------
function gate(W, o, d) {
  const LO = -80, inst = () => studio.device(o, d.id);
  const c = surface(W, "gate", () => `${sigOf(d)}|${inst()?.meter ?? 0}`, (g, w, H) => {
    const v = vals(d), xOf = (db) => (db - LO) / -LO * w, open = inst()?.meter === 1;
    g.strokeStyle = INK.grid; g.font = LABEL; g.fillStyle = INK.label; g.textBaseline = "bottom";
    for (const db of [-60, -40, -20]) { const x = Math.round(xOf(db)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(String(db), x + 3, H - 2); }
    g.fillStyle = "rgba(255,159,10,.1)"; g.fillRect(xOf(v.threshold - v.ret), 0, xOf(v.threshold) - xOf(v.threshold - v.ret), H);
    const tx = Math.round(xOf(v.threshold)) + 0.5;
    g.strokeStyle = INK.curve; g.lineWidth = 1.5; g.beginPath(); g.moveTo(tx, 0); g.lineTo(tx, H); g.stroke(); g.lineWidth = 1;
    g.beginPath(); g.arc(w - 12, 12, 5, 0, 2 * Math.PI); g.fillStyle = open && d.on !== false ? "#4ee08a" : "#2a2a2f"; g.fill();
    g.fillStyle = INK.label; g.textBaseline = "middle"; g.textAlign = "right"; g.fillText(open ? "Open" : "Closed", w - 22, 12); g.textAlign = "start";
  }, () => studio.busy);
  dragOn(c, () => (x) => { touch(); put(o, d, "threshold", clamp(LO + x / sizeOf(c)[0] * -LO, -80, 0)); });
  return c;
}

// ---- Limiter: how hard it's working -----------------------------------------------------
function limiter(W, o, d) {
  const inst = () => studio.device(o, d.id);
  return surface(W, "limiter", () => (inst()?.meter ?? 0).toFixed(1), (g, w, H) => {
    const gr = Math.min(0, inst()?.meter ?? 0), mw = 14, x0 = w - mw, scale = H - 18;
    g.font = LABEL; g.fillStyle = INK.label; g.textBaseline = "middle"; g.textAlign = "right";
    for (const db of [0, -6, -12, -18]) g.fillText(String(db), x0 - 5, 6 + (-db / 24) * (scale - 12));
    g.fillStyle = gr < -0.05 ? INK.curve : INK.label; g.textBaseline = "bottom"; g.textAlign = "center"; g.fillText(grText(gr), w / 2, H - 2);
    g.textAlign = "start";
    grMeter(g, x0, mw, scale, gr);
  }, () => studio.busy);
}

// ---- Saturator: the shaping curve at the current drive ------------------------------------
function sat(W, o, d) {
  return surface(W, "sat", () => sigOf(d), (g, w, H) => {
    const v = vals(d), a = amp(v.drive), fn = SHAPES[v.type], R = 1.4, xOf = (x) => (x + R) / (2 * R) * w, yOf = (y) => H - (y + R) / (2 * R) * H;
    g.strokeStyle = INK.grid;
    for (const t of [-1, 0, 1]) { g.beginPath(); g.moveTo(xOf(t) + 0.5, 0); g.lineTo(xOf(t) + 0.5, H); g.moveTo(0, yOf(t) + 0.5); g.lineTo(w, yOf(t) + 0.5); g.stroke(); }
    g.strokeStyle = INK.zero; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xOf(-R), yOf(-R)); g.lineTo(xOf(R), yOf(R)); g.stroke(); g.setLineDash([]);
    g.beginPath();
    for (let px = 0; px <= w; px++) {
      const x = -R + px / w * 2 * R, y = (fn(clamp(a * x, -4, 4)) * v.mix + x * (1 - v.mix)) * amp(v.out);
      if (px) g.lineTo(px, yOf(clamp(y, -R, R))); else g.moveTo(px, yOf(clamp(y, -R, R)));
    }
    g.strokeStyle = d.on === false ? INK.label : INK.curve; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
  });
}

// ---- Reverb: the shape of the tail -------------------------------------------------------
function reverb(W, o, d) {
  return surface(W, "reverb", () => sigOf(d), (g, w, H) => {
    const v = vals(d), span = Math.max(1, v.pre / 1000 + v.decay * 1.1), xOf = (t) => t / span * w;
    g.strokeStyle = INK.grid; g.font = LABEL; g.fillStyle = INK.label; g.textBaseline = "bottom";
    const step = span > 8 ? 2 : span > 3 ? 1 : 0.5;
    for (let t = step; t < span; t += step) { const x = Math.round(xOf(t)) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.fillText(`${t}s`, x + 3, H - 2); }
    const x0 = xOf(v.pre / 1000), top = 10;
    g.beginPath(); g.moveTo(x0, H);
    for (let px = x0; px <= w; px += 2) { const t = (px - x0) / w * span, e = Math.exp(-6.91 * t / v.decay); g.lineTo(px, H - e * (H - top)); }
    g.lineTo(w, H); g.closePath();
    const grad = g.createLinearGradient(x0, 0, w, 0);
    grad.addColorStop(0, "rgba(255,159,10,.34)"); grad.addColorStop(clamp(v.damp / 20000, 0.05, 1), "rgba(255,159,10,.12)"); grad.addColorStop(1, "rgba(255,159,10,.03)");
    g.fillStyle = grad; g.fill();
    g.strokeStyle = INK.curve;
    const er = v.size * 0.065;
    for (let r = 1; r <= 8; r++) { const x = Math.round(x0 + xOf(er * r / 8)) + 0.5, hh = (H - top) * (1 - r / 11); g.beginPath(); g.moveTo(x, H); g.lineTo(x, H - hh); g.stroke(); }
    g.fillStyle = INK.label; g.textBaseline = "top"; g.textAlign = "right"; g.fillText(`${v.decay.toFixed(2)} s`, w - 4, 3); g.textAlign = "start";
  });
}

export const VIEWS = { eq, filter, comp, gate, limiter, sat, reverb };
