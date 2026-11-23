// Crate Additive's parameters, in the order native/synth/additive.hpp lists them: the organ's nine
// drawbars and its percussion, click, scanner, rotary and drive; the harmonic layer's partials and
// envelope; an LFO; the output. The synth itself is the C++ in native/synth, here as add.wasm.

// each drawbar's footage, and its colour on a tonewheel organ: brown below the fundamental,
// white for its octaves, black for the other harmonics
export const DRAWBARS = [["16'", "brown"], ["5⅓'", "brown"], ["8'", "white"], ["4'", "white"], ["2⅔'", "black"], ["2'", "white"], ["1⅗'", "black"], ["1⅓'", "black"], ["1'", "white"]];
export const SCANNER = ["Off", "V1", "V2", "V3", "C1", "C2", "C3"];

const pct = (k, n, def, min = 0) => ({ k, n, min, max: 1, def, unit: "%" });
const secs = (k, n, def) => ({ k, n, min: 0, max: 10, def, unit: "s", curve: 3 });
const flag = (k, n, def) => ({ k, n, bool: true, def });
const signed = (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`;

export const ADD_PARAMS = [
  ...DRAWBARS.map(([n], i) => ({ k: `db${i + 1}`, n, min: 0, max: 8, def: i < 3 ? 8 : 0, step: 1, text: (v) => `${Math.round(v)}` })),
  pct("organ", "Organ", 1),
  { k: "perc", n: "Percussion", opts: ["Off", "2nd", "3rd"], def: 0 }, flag("pslow", "Slow", false), flag("psoft", "Soft", false),
  pct("click", "Click", 0.3), { k: "vib", n: "Vibrato", opts: SCANNER, def: 0 },
  pct("harm", "Harmonics", 0), { k: "parts", n: "Partials", min: 1, max: 32, def: 16, step: 1, text: (v) => `${Math.round(v)}` },
  { k: "tilt", n: "Tilt", min: -12, max: 6, def: -6, text: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB/oct` },
  { k: "odd", n: "Odd/Even", min: -1, max: 1, def: 0, text: (v) => (Math.abs(v) < 0.02 ? "Both" : v > 0 ? `Odd ${Math.round(v * 100)}%` : `Even ${Math.round(-v * 100)}%`) },
  pct("stretch", "Stretch", 0), { k: "fpeak", n: "Formant", min: 100, max: 8000, def: 1500, unit: "Hz", log: true },
  { k: "fgain", n: "Boost", min: 0, max: 24, def: 0, unit: "dB" }, { k: "fwidth", n: "Width", min: 0.2, max: 4, def: 1, log: true, text: (v) => `${v.toFixed(1)} oct` },
  pct("damp", "Damping", 0.3), pct("spread", "Spread", 0), { k: "hoct", n: "Octave", min: -2, max: 2, def: 0, step: 1, text: signed }, pct("vel", "Velocity", 0.5),
  secs("aa", "Attack", 0.005), secs("ad", "Decay", 1), pct("as", "Sustain", 1), secs("ar", "Release", 0.3),
  { k: "lrate", n: "Rate", min: 0.05, max: 12, def: 5, unit: "Hz", log: true }, pct("lvib", "Vibrato", 0), pct("ltrem", "Tremolo", 0), pct("ltilt", "Tilt", 0),
  flag("rotary", "Rotary", false), flag("fast", "Fast", false), pct("drive", "Drive", 0), pct("level", "Level", 0.27),  // a chord near -6 dBFS
];
