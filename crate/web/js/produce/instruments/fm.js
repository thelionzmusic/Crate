// Crate FM's parameters, in the order native/synth/fm.hpp lists them (tests/web/native_produce.js
// checks the two agree): four operators, the algorithm, voice, filter, envelopes, LFOs and a
// six-slot modulation matrix. The synth itself is the C++ in native/synth, here as fm.wasm.

const WAVES = ["Sine", "Triangle", "Saw", "Square", "Pulse", "Vowel"];
export const ALGOS = ["Stack", "Branch", "Three to one", "Two stacks", "Shared mod", "Stack + carrier", "Pair + two", "Additive"];
// for each algorithm: what modulates each operator (A–D) and which are heard, as fm.hpp has them
export const ROUTES = [[[1], [2], [3], []], [[1, 2], [], [3], []], [[1, 2, 3], [], [], []], [[1], [], [3], []],
  [[3], [3], [3], []], [[], [2], [3], []], [[1], [], [], []], [[], [], [], []]];
export const HEARD = [[0], [0], [0], [0, 2], [0, 1, 2], [0, 1], [0, 2, 3], [0, 1, 2, 3]];
const LFO_SHAPES = ["Sine", "Triangle", "Saw down", "Saw up", "Square", "Random"];
const LFO_DIVS = ["4 bars", "2 bars", "1 bar", "1/2", "1/2T", "1/4", "1/4T", "1/8", "1/8T", "1/16", "1/16T", "1/32"];
export const SOURCES = ["Off", "LFO 1", "LFO 2", "Mod env", "Velocity", "Macro", "Key", "Random"];
export const TARGETS = ["Pitch", "Cutoff", "Resonance", "FM", "Op A", "Op B", "Op C", "Op D", "Wave", "Pan", "Amp", "Detune"];
const FILTERS = ["Off", "Low 12", "Low 24", "High 12", "Band", "Notch"];

const pct = (k, n, def, min = 0) => ({ k, n, min, max: 1, def, unit: "%" });
const secs = (k, n, def) => ({ k, n, min: 0, max: 10, def, unit: "s", curve: 3 });
const int = (k, n, min, max, def, text = (v) => `${Math.round(v)}`) => ({ k, n, min, max, def, step: 1, text });
const pick = (k, n, opts, def) => ({ k, n, opts, def });
const flag = (k, n, def) => ({ k, n, bool: true, def });
const signed = (v) => `${v > 0 ? "+" : ""}${Math.round(v)}`;
// a wavetable position: the shape, or where between two it sits
const waveText = (v) => { const i = Math.floor(v), f = v - i; return f < 0.02 ? WAVES[i] : f > 0.98 ? WAVES[i + 1] : `${WAVES[i]}→${WAVES[i + 1]} ${Math.round(f * 100)}%`; };

const op = (o, ratio, level) => [
  { k: `${o}wave`, n: "Wave", min: 0, max: 5, def: 0, text: waveText },
  { k: `${o}ratio`, n: "Ratio", min: 0.5, max: 16, def: ratio, step: 0.5, text: (v) => `×${v}` },
  { k: `${o}fine`, n: "Fine", min: -100, max: 100, def: 0, text: (v) => `${signed(v)} ct` },
  pct(`${o}level`, "Level", level), pct(`${o}fb`, "Feedback", 0),
  secs(`${o}att`, "Attack", 0.002), secs(`${o}dec`, "Decay", 1), pct(`${o}sus`, "Sustain", 1), secs(`${o}rel`, "Release", 0.3),
  pct(`${o}vel`, "Velocity", 0),
];
const lfo = (i, rate, div, trig) => [
  pick(`l${i}shape`, "Shape", LFO_SHAPES, 0), { k: `l${i}rate`, n: "Rate", min: 0.05, max: 30, def: rate, unit: "Hz", log: true },
  flag(`l${i}sync`, "Sync", false), pick(`l${i}div`, "Rate", LFO_DIVS, div), flag(`l${i}trig`, "Retrig", trig),
];
const slot = (i) => [pick(`m${i}src`, "Source", SOURCES, 0), pick(`m${i}dst`, "Target", TARGETS, 0), { k: `m${i}amt`, n: "Amount", min: -1, max: 1, def: 0, unit: "%" }];

export const FM_PARAMS = [
  ...op("a", 1, 0.8), ...op("b", 1, 0.35), ...op("c", 2, 0), ...op("d", 3, 0),
  pick("algo", "Algorithm", ALGOS, 0), pct("fm", "FM", 0.5), pct("sub", "Sub", 0), pct("noise", "Noise", 0),
  int("oct", "Octave", -3, 3, 0, signed), int("semi", "Semi", -12, 12, 0, signed), int("uni", "Unison", 1, 7, 1), pct("detune", "Detune", 0.25), pct("spread", "Spread", 0.5),
  { k: "glide", n: "Glide", min: 0, max: 2, def: 0, unit: "s", curve: 2 }, pick("mono", "Voice", ["Poly", "Mono", "Legato"], 0), pct("vel", "Velocity", 0.6),
  pick("ftype", "Filter", FILTERS, 0), { k: "cutoff", n: "Cutoff", min: 20, max: 20000, def: 20000, unit: "Hz", log: true }, pct("res", "Res", 0.1), pct("drive", "Drive", 0),
  pct("fenv", "Env", 0, -1), pct("fkey", "Key", 0), pct("fvel", "Velocity", 0),
  secs("aa", "Attack", 0.002), secs("ad", "Decay", 0.3), pct("as", "Sustain", 1), secs("ar", "Release", 0.25),
  secs("ma", "Attack", 0.002), secs("md", "Decay", 0.4), pct("ms", "Sustain", 0), secs("mr", "Release", 0.3),
  ...lfo(1, 2, 7, true), ...lfo(2, 0.5, 5, false),
  ...[1, 2, 3, 4, 5, 6].flatMap(slot),
  pct("macro", "Macro", 0), pct("dist", "Distortion", 0), pct("level", "Level", 0.25),  // a chord near -6 dBFS
];
