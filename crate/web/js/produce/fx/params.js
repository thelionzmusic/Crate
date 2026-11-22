// A device parameter: its range, how a knob travels across it, and how its value reads.
//   number  {k, n, min, max, def, unit, log?, curve?, step?}   stored in its own unit (Hz, dB, ms; % as 0–1)
//   choice  {k, n, opts: [...], def: index}
//   toggle  {k, n, bool: true, def}
// Any of them may carry text(v) to say its value its own way.
// Sets store only what's been changed from the default, so devices can gain parameters later.

export const valueOf = (p, params) => params?.[p.k] ?? p.def;
// where a knob's lit arc starts: at 0 for a range either side of it, otherwise at the bottom
export const origin = (p) => (!p.opts && !p.bool && p.min < 0 && p.max > 0 ? toNorm(p, 0) : false);

export function toNorm(p, v) {
  if (p.opts) return p.opts.length > 1 ? v / (p.opts.length - 1) : 0;
  if (p.bool) return v ? 1 : 0;
  if (p.log) return Math.log(v / p.min) / Math.log(p.max / p.min);
  const k = (v - p.min) / (p.max - p.min);
  return p.curve ? k ** (1 / p.curve) : k;
}

export function fromNorm(p, n) {
  n = Math.min(1, Math.max(0, n));
  if (p.opts) return Math.round(n * (p.opts.length - 1));
  if (p.bool) return n >= 0.5;
  const v = p.log ? p.min * (p.max / p.min) ** n : p.min + (p.curve ? n ** p.curve : n) * (p.max - p.min);
  return p.step ? Math.round(v / p.step) * p.step : v;
}

const fixed = (v, d) => (Math.abs(v) < 10 ** -d / 2 ? 0 : v).toFixed(d);  // never "-0.0"

export function fmt(p, v) {
  if (p.text) return p.text(v);
  if (p.opts) return p.opts[v];
  if (p.bool) return v ? "On" : "Off";
  switch (p.unit) {
    case "Hz": return v >= 1000 ? `${fixed(v / 1000, v >= 10000 ? 1 : 2)} kHz` : `${fixed(v, v < 100 ? 1 : 0)} Hz`;
    case "dB": return p.inf && v <= p.min ? "-inf dB" : `${fixed(v, Math.abs(v) < 10 ? 1 : 0)} dB`;
    case "ms": return v >= 1000 ? `${fixed(v / 1000, 2)} s` : `${fixed(v, v < 10 ? 2 : v < 100 ? 1 : 0)} ms`;
    case "s": return `${fixed(v, v < 10 ? 2 : 1)} s`;
    case "%": return `${Math.round(v * 100)} %`;
    case ":1": return v >= p.max ? "inf : 1" : `${fixed(v, v < 10 ? 2 : 1)} : 1`;
    case "bits": return `${Math.round(v)} bit`;
    case "x": return `${fixed(v, 1)} x`;
    case "pan": return Math.abs(v) < 0.005 ? "C" : `${Math.round(Math.abs(v) * 50)}${v < 0 ? "L" : "R"}`;
    default: return fixed(v, 2);
  }
}

// note lengths a synced time or rate can take, in beats
export const DIVISIONS = [["1/32", 1 / 8], ["1/16", 1 / 4], ["1/8T", 1 / 3], ["1/8", 1 / 2], ["3/16", 3 / 4], ["1/4T", 2 / 3], ["1/4", 1],
  ["3/8", 1.5], ["1/2", 2], ["1 bar", 4], ["2 bars", 8], ["4 bars", 16]];
export const DIV_NAMES = DIVISIONS.map(([n]) => n);

// a typed value ("1.2k", "-3", "250ms", "20L", "inf") in the parameter's unit, or null
export function parse(p, text) {
  const s = text.trim().toLowerCase(), n = parseFloat(s);
  if (p.unit === "pan") return s === "c" ? 0 : Number.isNaN(n) ? null : Math.max(-1, Math.min(1, (s.includes("l") ? -n : n) / 50));
  if (p.unit === ":1" && s.startsWith("inf")) return p.max;
  if (p.unit === "dB" && s.startsWith("-inf")) return p.min;
  if (Number.isNaN(n)) return null;
  let v = n;
  if (p.unit === "Hz" && s.includes("k")) v *= 1000;
  if (p.unit === "ms" && /\ds$/.test(s)) v *= 1000;
  if (p.unit === "s" && s.endsWith("ms")) v /= 1000;
  if (p.unit === "%") v /= 100;
  v = Math.min(p.max, Math.max(p.min, v));
  return p.step ? Math.round(v / p.step) * p.step : v;
}
