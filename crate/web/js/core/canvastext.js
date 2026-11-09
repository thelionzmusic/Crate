// Fast-changing text (clocks, positions) drawn on a canvas. Changing DOM text forces the
// browser to re-lay out and repaint the panel around it; a canvas only repaints itself.
// Font, colour, alignment and tracking come from the canvas's own CSS.
import { sizeOf, watchSize } from "./dom.js";

export class CanvasText {
  constructor(canvas) { this.c = watchSize(canvas); this.shown = ""; this.css = null; }
  set(v) {
    const c = this.c, [cw, ch] = sizeOf(c); if (!cw || !ch) return;
    const key = `${v}|${cw}|${ch}`; if (key === this.shown) return; this.shown = key;
    const css = (this.css ||= getComputedStyle(c)), dpr = devicePixelRatio, w = Math.round(cw * dpr), hh = Math.round(ch * dpr);
    if (c.width !== w || c.height !== hh) { c.width = w; c.height = hh; }
    const g = c.getContext("2d"), right = css.textAlign === "right" || css.textAlign === "end";
    g.clearRect(0, 0, w, hh);
    g.font = `${css.fontWeight} ${parseFloat(css.fontSize) * dpr}px ${css.fontFamily}`; g.fontVariantNumeric = "tabular-nums";
    g.letterSpacing = css.letterSpacing === "normal" ? "0px" : `${parseFloat(css.letterSpacing) * dpr}px`;
    g.fillStyle = css.color; g.textAlign = right ? "right" : "left"; g.textBaseline = "middle";
    g.fillText(v, right ? w : 0, hh / 2 + dpr);
  }
}
