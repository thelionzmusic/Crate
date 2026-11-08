// Stacked scrolling waveforms, one lane per deck. The waveform comes from cached tiles that
// are blitted each frame (cheap, GPU-composited); beats, cues and the playhead are drawn
// on top. A lane redraws only while its deck moves or something on it changes.
import { cueColor, PAD_LETTERS } from "../core/format.js";
import { TileStrip } from "../core/wave.js";
import { sizeOf, watchSize } from "../core/dom.js";

export class Lane {
  constructor(canvas, deck, hue) {
    this.cv = watchSize(canvas); this.d = deck; this.hue = hue;
    this.tiles = new TileStrip(); this.last = ""; this.font = "";
  }
  draw(zoom) {
    const cv = this.cv, d = this.d, dpr = devicePixelRatio, [cw, ch] = sizeOf(cv);
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr); if (!W || !H) return;
    const now = d.loaded ? d.time() : 0, rate = Math.max(0.05, d.rate);
    const sig = `${W}|${H}|${zoom}|${d.version}|${d.loaded ? now.toFixed(4) : "-"}|${rate.toFixed(5)}`;
    if (sig === this.last) return;
    this.last = sig;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; this.tiles.clear(); }
    const g = cv.getContext("2d");
    g.clearRect(0, 0, W, H);
    if (!d.loaded) return;

    // waveform: tiles are rendered at the deck's natural speed and stretched by 1/rate
    const pps = W / zoom, fps = d.wave.length / 3 / d.duration, s0 = now - (W / 2) / pps * rate;
    this.tiles.draw(g, d.wave, fps, d.t.id, s0, 0, W, H, pps, 1 / rate);
    g.save(); g.globalCompositeOperation = "source-atop"; g.fillStyle = "rgba(6,7,10,.42)"; g.fillRect(0, 0, W / 2, H); g.restore();

    const xOf = (s) => W / 2 + (s - now) / rate * pps;
    if (d.grid.ok) {  // beat grid: bars full height, beats as ticks
      const gr = d.grid, i0 = Math.ceil(gr.index(now - zoom * rate / 2)), i1 = Math.floor(gr.index(now + zoom * rate / 2));
      for (let i = i0; i <= i1; i++) {
        const x = Math.round(xOf(gr.time(i)));
        if (gr.isDownbeat(i)) { g.fillStyle = "rgba(255,255,255,.55)"; g.fillRect(x, 0, 1.5 * dpr, H); }
        else { g.fillStyle = "rgba(255,255,255,.16)"; g.fillRect(x, 0, dpr, H * 0.18); g.fillRect(x, H - H * 0.18, dpr, H * 0.18); }
      }
    }
    if (d.loop) { const a = xOf(d.loop[0]), b = xOf(d.loop[1]); g.fillStyle = "rgba(255,165,58,.16)"; g.fillRect(a, 0, b - a, H); g.fillStyle = "#ffa53a"; g.fillRect(a, 0, 2 * dpr, H); g.fillRect(b - 2 * dpr, 0, 2 * dpr, H); }

    this.font ||= getComputedStyle(document.body).fontFamily;
    g.font = `700 ${10 * dpr}px ${this.font}`; g.textBaseline = "middle";
    for (const q of d.cues) {
      const x = xOf(q.start_ms / 1000); if (x < -160 * dpr || x > W) continue;
      const col = cueColor(q); g.fillStyle = col; g.fillRect(x, 0, 1.5 * dpr, H);
      if (!q.slot) continue;
      const loop = q.end_ms > q.start_ms, label = PAD_LETTERS[q.slot - 1] + (q.name ? `  ${q.name}` : ""), tw = g.measureText(label).width + 9 * dpr;
      if (loop) { g.globalAlpha = 0.14; g.fillRect(x, 0, (q.end_ms - q.start_ms) / 1000 / rate * pps, H); g.globalAlpha = 1; }
      const y = loop ? H - 16 * dpr : 2 * dpr;  // loop labels sit at the bottom, so a cue on the same beat stays readable
      g.beginPath(); g.roundRect(x, y, tw, 14 * dpr, 3 * dpr); g.fill(); g.fillStyle = "rgba(0,0,0,.85)"; g.fillText(label, x + 4.5 * dpr, y + 7 * dpr);
    }
    g.save(); g.shadowColor = this.hue; g.shadowBlur = 12 * dpr; g.fillStyle = "#fff"; g.fillRect(W / 2 - dpr, 0, 2 * dpr, H); g.restore();
  }
  invalidate() { this.last = ""; }
}
