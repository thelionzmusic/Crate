// Crate Drum's parameters, in the order native/synth/drum.hpp lists them: the type, the body
// (tuning, wave, pitch drop, envelope, drive), the click, the noise (with clap bursts), the metal,
// and the output. The synth itself is the C++ in native/synth, here as drum.wasm.

export const TYPES = ["Kick", "Snare", "Clap", "Hat", "Tom", "Rim", "Perc", "Cymbal", "FX"];

const pct = (k, n, def) => ({ k, n, min: 0, max: 1, def, unit: "%" });
const ms = (k, n, min, max, def, log = true) => ({ k, n, min, max, def, unit: "ms", log });
const hz = (k, n, min, max, def) => ({ k, n, min, max, def, unit: "Hz", log: true });

export const DRUM_PARAMS = [
  { k: "model", n: "Type", opts: TYPES, def: 0 }, hz("tune", "Tune", 20, 800, 50), { k: "key", n: "Key", bool: true, def: true },
  { k: "bwave", n: "Wave", min: 0, max: 2, def: 0, text: (v) => (v < 0.05 ? "Sine" : v > 1.95 ? "Saw" : Math.abs(v - 1) < 0.05 ? "Triangle" : `${v < 1 ? "Sine→Tri" : "Tri→Saw"} ${Math.round((v % 1) * 100)}%`) },
  { k: "bpitch", n: "Drop", min: 0, max: 72, def: 36, text: (v) => `${Math.round(v)} st` }, ms("bptime", "Time", 1, 1000, 40), pct("bpcurve", "Bend", 0.6),
  ms("battack", "Attack", 0, 50, 0, false), ms("bhold", "Hold", 0, 500, 20, false), ms("bdecay", "Decay", 10, 4000, 450), pct("bcurve", "Curve", 0.5), pct("blevel", "Body", 1), pct("bdrive", "Drive", 0),
  pct("click", "Click", 0.3), { k: "ctype", n: "Type", opts: ["Noise", "Blip", "Beater"], def: 0 }, ms("cdecay", "Length", 1, 50, 6), hz("ctone", "Tone", 500, 16000, 5000),
  pct("noise", "Noise", 0), { k: "nfilter", n: "Filter", opts: ["Low", "Band", "High"], def: 1 }, hz("ncut", "Cutoff", 100, 16000, 4000), pct("nres", "Res", 0.2),
  ms("nattack", "Attack", 0, 50, 0, false), ms("ndecay", "Decay", 5, 3000, 150), { k: "nclap", n: "Claps", min: 1, max: 4, def: 1, step: 1, text: (v) => `${Math.round(v)}` }, ms("nspace", "Spacing", 3, 30, 10, false),
  pct("metal", "Metal", 0), hz("mfreq", "Pitch", 100, 1000, 400), ms("mdecay", "Decay", 5, 4000, 80), hz("mtone", "Tone", 1000, 16000, 7000),
  pct("drive", "Drive", 0), pct("clip", "Clip", 0), { k: "low", n: "Low", min: -12, max: 12, def: 0, unit: "dB" }, { k: "high", n: "High", min: -12, max: 12, def: 0, unit: "dB" },
  pct("vel", "Velocity", 0.5), { k: "choke", n: "Choke", bool: true, def: true }, pct("level", "Level", 0.5),  // a kick near -6 dBFS
];
