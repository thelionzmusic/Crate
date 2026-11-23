// Crate Grain's parameters, in the order native/synth/granular.hpp lists them: the source and
// where grains are read from it, the grains themselves, their pitch, the filter, the envelopes,
// an LFO and the output. The synth itself is the C++ in native/synth, here as grain.wasm.

export const SOURCES = ["Choir", "Strings", "Glass", "Breath", "Bells", "Organ", "Vowels", "Metal", "Sample"];
export const SAMPLE = SOURCES.length - 1;
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const pct = (k, n, def, min = 0) => ({ k, n, min, max: 1, def, unit: "%" });
const secs = (k, n, def) => ({ k, n, min: 0, max: 10, def, unit: "s", curve: 3 });
const signed = (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`;

export const GRAIN_PARAMS = [
  { k: "source", n: "Source", opts: SOURCES, def: 0 },
  { k: "root", n: "Root", min: 24, max: 96, def: 60, step: 1, text: (v) => `${NAMES[Math.round(v) % 12]}${Math.floor(Math.round(v) / 12) - 2}` },
  pct("pos", "Position", 0.25), pct("spray", "Spray", 0.1),
  { k: "scan", n: "Scan", min: -2, max: 2, def: 0, text: (v) => (Math.abs(v) < 0.01 ? "Frozen" : `${v > 0 ? "" : "−"}×${Math.abs(v).toFixed(2)}`) },
  { k: "size", n: "Size", min: 5, max: 1000, def: 120, unit: "ms", log: true },
  { k: "density", n: "Density", min: 1, max: 200, def: 30, log: true, text: (v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}/s` },
  pct("jitter", "Jitter", 0.3),
  { k: "pitch", n: "Pitch", min: -24, max: 24, def: 0, step: 1, text: (v) => `${signed(v)} st` },
  pct("prand", "Random", 0), pct("jump", "Jumps", 0), pct("rev", "Reverse", 0), pct("shape", "Smooth", 1), pct("pan", "Spread", 0.5),
  { k: "ftype", n: "Filter", opts: ["Off", "Low 12", "Low 24", "High 12", "Band", "Notch"], def: 0 },
  { k: "cutoff", n: "Cutoff", min: 20, max: 20000, def: 20000, unit: "Hz", log: true }, pct("res", "Res", 0.1), pct("fenv", "Env", 0, -1),
  secs("aa", "Attack", 0.02), secs("ad", "Decay", 1), pct("as", "Sustain", 1), secs("ar", "Release", 0.6),
  secs("ma", "Attack", 0.01), secs("md", "Decay", 1), pct("ms", "Sustain", 0), secs("mr", "Release", 0.5),
  { k: "lrate", n: "Rate", min: 0.02, max: 20, def: 0.3, unit: "Hz", log: true }, { k: "lshape", n: "Shape", opts: ["Sine", "Triangle", "Saw", "Square"], def: 0 },
  pct("lpos", "Position", 0), pct("lcut", "Cutoff", 0), pct("lsize", "Size", 0), pct("lpitch", "Pitch", 0),
  pct("vel", "Velocity", 0.5), pct("level", "Level", 0.1),  // a chord near -6 dBFS
];
