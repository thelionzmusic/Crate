// Waveform drawing, shared by the list, the preview deck and the performance lanes.
//
// Waveforms are 3 bytes per frame (low, mid, high) at a fixed rate. Drawing writes 32-bit
// pixels straight into an ImageData that's kept between frames, and band maxima go into a
// scratch array, so redrawing allocates nothing.

export const abgr = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
export const rgbOf = (l, m, hh, top) => abgr((60 + 195 * l / top) | 0, (30 + 200 * m / top) | 0, (50 + 205 * hh / top) | 0);
const coreOf = (l, m, hh, top) => abgr(Math.min(255, 105 + 195 * l / top) | 0, Math.min(255, 75 + 200 * m / top) | 0, Math.min(255, 95 + 205 * hh / top) | 0);
const BAND3 = [abgr(58, 123, 255), abgr(255, 179, 64), abgr(245, 245, 247)], BAND3_SCALE = [1, 0.86, 0.72];

// max of each band over frames [a, b) into out; returns the loudest band
export function column(w, a, b, out) {
  let l = 0, m = 0, hh = 0;
  const n = w.length / 3, end = Math.min(n, b);
  for (let i = Math.max(0, a), k = i * 3; i < end; i++, k += 3) {
    if (w[k] > l) l = w[k];
    if (w[k + 1] > m) m = w[k + 1];
    if (w[k + 2] > hh) hh = w[k + 2];
  }
  out[0] = l; out[1] = m; out[2] = hh;
  return Math.max(l, m, hh);
}

// One painter per canvas. range(x) gives the frame span [a, b) for pixel column x.
export class Painter {
  constructor() { this.img = null; this.px = null; this.band = new Uint8Array(3); }
  buffer(ctx, W, H) {
    if (!this.img || this.img.width !== W || this.img.height !== H) { this.img = ctx.createImageData(W, H); this.px = new Uint32Array(this.img.data.buffer); }
    else this.px.fill(0);
    return this.px;
  }
  paint(ctx, W, H, wave, range, mode = "rgb") {
    const px = this.buffer(ctx, W, H), mid = H / 2, b = this.band, span = [0, 0];
    const put = (x, amp, c) => { const y1 = Math.min(H, Math.round(mid + amp)); for (let y = Math.max(0, Math.round(mid - amp)); y < y1; y++) px[y * W + x] = c; };
    for (let x = 0; x < W; x++) {
      if (!range(x, span)) continue;
      const top = column(wave, span[0], span[1], b); if (!top) continue;
      if (mode === "rgb") {
        put(x, Math.pow(top / 255, 0.85) * mid, rgbOf(b[0], b[1], b[2], top));
        const core = Math.pow(Math.min(b[0], b[1]) / 255, 0.85) * mid * 0.5;
        if (core > 1) put(x, core, coreOf(b[0], b[1], b[2], top));
      } else for (let k = 0; k < 3; k++) { const a = Math.pow(b[k] / 255, 0.8) * mid * BAND3_SCALE[k]; if (a > 0.5) put(x, a, BAND3[k]); }
    }
    ctx.putImageData(this.img, 0, 0);
  }
}

// The whole track squeezed into W columns, drawn once into an offscreen canvas.
export function overview(wave, W, H, mode = "rgb") {
  const off = new OffscreenCanvas(Math.max(1, W), Math.max(1, H)), n = wave.length / 3;
  new Painter().paint(off.getContext("2d"), W, H, wave, (x, s) => { s[0] = Math.floor(x * n / W); s[1] = Math.max(s[0] + 1, Math.floor((x + 1) * n / W)); return true; }, mode);
  return off;
}

// Row thumbnail: 32 rounded bars (3 data columns each) at a fixed size, drawn at 2x so
// they stay crisp, with a faint reflection under the baseline.
const MINI_BARS = 32;
export function mini(w) {
  const S = 2, W = 96 * S, H = 24 * S, base = 16 * S, step = W / MINI_BARS, bw = step - S, c = document.createElement("canvas");
  c.className = "mini"; c.width = W; c.height = H;
  const g = c.getContext("2d"), b = new Uint8Array(3);
  for (let i = 0; i < MINI_BARS; i++) {
    const top = column(w, i * 3, i * 3 + 3, b); if (!top) continue;
    const col = rgbOf(b[0], b[1], b[2], top), r = col & 255, gg = (col >> 8) & 255, bl = (col >> 16) & 255;
    const amp = Math.max(S, Math.round(Math.pow(top / 255, 0.9) * (base - S))), x = i * step;
    g.fillStyle = `rgb(${r},${gg},${bl})`; g.beginPath(); g.roundRect(x, base - amp, bw, amp, [S, S, 0, 0]); g.fill();
    g.fillStyle = `rgba(${r},${gg},${bl},.22)`; g.fillRect(x, base + S, bw, Math.round(amp * 0.35));
  }
  return c;
}

// Scrolling waveforms rendered once into tiles and blitted each frame, instead of
// recomputing every pixel at 60 fps. Tiles are cached per track, zoom and height.
const TILE = 512;
export class TileStrip {
  constructor(limit = 24) { this.cache = new Map(); this.limit = limit; this.painter = new Painter(); }
  // draw source seconds [s0, s1) at pps source-pixels per second, offset so s0 lands at x
  draw(ctx, wave, fps, key, s0, x, W, H, pps, scaleX = 1, mode = "rgb") {
    const t0 = Math.floor(s0 * pps / TILE);
    for (let t = t0; ; t++) {
      const dx = x + (t * TILE / pps - s0) * pps * scaleX;
      if (dx >= W) break;
      if (t < 0) continue;
      if (t * TILE / pps * fps >= wave.length / 3) break;
      ctx.drawImage(this.tile(wave, fps, key, t, H, pps, mode), dx, 0, TILE * scaleX + 0.5, H);
    }
  }
  tile(wave, fps, key, t, H, pps, mode) {
    const id = `${key}|${pps.toFixed(3)}|${H}|${mode}|${t}`;
    let c = this.cache.get(id);
    if (c) { this.cache.delete(id); this.cache.set(id, c); return c; }  // keep recently used last
    c = new OffscreenCanvas(TILE, H);
    const f0 = t * TILE / pps * fps, step = fps / pps;
    this.painter.paint(c.getContext("2d"), TILE, H, wave, (px, s) => { s[0] = Math.floor(f0 + px * step); s[1] = Math.max(s[0] + 1, Math.floor(f0 + (px + 1) * step)); return true; }, mode);
    this.cache.set(id, c);
    if (this.cache.size > this.limit) this.cache.delete(this.cache.keys().next().value);
    return c;
  }
  clear() { this.cache.clear(); }
}
