// Crate's built-in audio effects: each one's parameters and how it's built on the audio graph.
// A device instance has an input and an output node, set(values, changed, bpm) to follow its
// parameters, and optionally a meter (gain reduction, gate state) or an analyser for its view.
import { amp } from "../../core/num.js";
import { DIVISIONS, DIV_NAMES } from "./params.js";

const qdb = (q) => 20 * Math.log10(q);  // lowpass and highpass take their Q in dB
const BW8 = [0.5098, 0.6013, 0.9, 2.5629];  // four biquads in a row: an 8th-order Butterworth, 48 dB/oct
// a start time in the past is taken as now, so no clock is needed to move a parameter smoothly
const glide = (p, v, t = 0.012) => p.setTargetAtTime(v, 0, t);

// ---- parameter shorthands
const pct = (k, n, def, min = 0, max = 1) => ({ k, n, min, max, def, unit: "%" });
const mixP = (def = 1) => pct("mix", "Dry/Wet", def);
const hz = (k, n, min, max, def) => ({ k, n, min, max, def, unit: "Hz", log: true });
const ms = (k, n, min, max, def) => ({ k, n, min, max, def, unit: "ms", log: true });
const db = (k, n, min, max, def, extra = {}) => ({ k, n, min, max, def, unit: "dB", ...extra });
const rate = (def, when) => ({ k: "rate", n: "Rate", min: 0.02, max: 20, def, unit: "Hz", log: true, when });
const synced = (v) => v.sync, free = (v) => !v.sync;  // `when`: a parameter shown only while it applies
const beatsOf = (div) => DIVISIONS[div][1];

// ---- graph helpers
function parts(ctx) {
  const gain = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const bq = (type = "peaking", f = 1000) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.gain.value = 0; return b; };
  // two channels whatever comes in, so mono sources still get stereo effects
  const stereo = () => Object.assign(gain(), { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
  // dry and wet summed at equal power, so 50% doesn't dip in level
  const wetDry = () => {
    const input = stereo(), output = gain(), dry = gain(0), wet = gain(1);
    input.connect(dry).connect(output); wet.connect(output);
    return { input, output, wet, mix: (m) => { glide(dry.gain, Math.cos(m * Math.PI / 2)); glide(wet.gain, Math.sin(m * Math.PI / 2)); } };
  };
  const lfo = () => { const o = ctx.createOscillator(); o.start(); return o; };
  return { gain, bq, stereo, wetDry, lfo };
}

// Shaping curves over ±4, so the input can run 12 dB hot before it reaches the curve's end
const SPAN = 4;
export const SHAPES = [
  (u) => Math.tanh(u),                                // Soft
  (u) => Math.max(-1, Math.min(1, u)),                // Hard
  (u) => Math.tanh(u + 0.3) - Math.tanh(0.3),         // Tube: asymmetric, so it adds even harmonics
  (u) => Math.sin(u * Math.PI / 2),                   // Fold
];
function curve(fn) {
  const c = new Float32Array(2049);
  for (let i = 0; i < c.length; i++) c[i] = fn((i / 1024 - 1) * SPAN);
  return c;
}

// a processor from dynamics.worklet.js; its parameters share our names, and it reports a meter
const worklet = (name, inputs = 1) => (ctx) => {
  const node = new AudioWorkletNode(ctx, name, { numberOfInputs: inputs, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit" });
  const inst = {
    input: node, output: node, meter: 0,
    set(v, changed) { for (const k of changed) { const p = node.parameters.get(k); if (p) glide(p, +v[k], 0.005); } },
    dispose() { node.port.postMessage("close"); },
  };
  node.port.onmessage = (e) => { inst.meter = e.data; };
  return inst;
};

// ---- EQ Eight ---------------------------------------------------------------------------
const EQ_TYPES = ["Low cut 48", "Low cut", "Low shelf", "Bell", "Notch", "High shelf", "High cut", "High cut 48"];
const EQ_BANDS = [[0, 30, false], [2, 90, true], [3, 250, true], [3, 700, true], [3, 1800, true], [3, 4500, true], [5, 9000, true], [7, 18000, false]];
const eqParams = EQ_BANDS.flatMap(([type, f, on], i) => {
  const b = i + 1;
  return [{ k: `on${b}`, n: `Band ${b}`, bool: true, def: on }, { k: `t${b}`, n: "Type", opts: EQ_TYPES, def: type },
    hz(`f${b}`, "Freq", 10, 22000, f), db(`g${b}`, "Gain", -15, 15, 0), { k: `q${b}`, n: "Q", min: 0.1, max: 18, def: 0.71, log: true }];
});
const eqCuts = (type) => (type === 0 || type === 7 ? 4 : 1);
export const eqHasGain = (type) => type === 2 || type === 3 || type === 5;

function eqBand(fs, on, type, f, g, q) {
  const kind = ["highpass", "highpass", "lowshelf", "peaking", "notch", "highshelf", "lowpass", "lowpass"][type], n = eqCuts(type);
  fs.forEach((x, i) => {
    const use = on && i < n, pass = kind === "highpass" || kind === "lowpass";
    x.type = use ? kind : "peaking";
    glide(x.frequency, f);
    glide(x.gain, use && eqHasGain(type) ? g : 0);
    glide(x.Q, !use ? 1 : n === 4 ? qdb(BW8[i]) : pass ? qdb(q) : q);
  });
}

function eqEight(ctx) {
  const { gain, bq, stereo } = parts(ctx), input = stereo(), output = gain();
  const bands = EQ_BANDS.map(() => [bq(), bq(), bq(), bq()]);
  let at = input;
  for (const f of bands.flat()) { at.connect(f); at = f; }
  at.connect(output);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 4096; analyser.smoothingTimeConstant = 0.8; output.connect(analyser);
  return {
    input, output, bands, analyser,
    set(v, ch) {
      for (let b = 1; b <= 8; b++) {
        if (["on", "t", "f", "g", "q"].some((x) => ch.has(x + b))) eqBand(bands[b - 1], v[`on${b}`], v[`t${b}`], v[`f${b}`], v[`g${b}`], v[`q${b}`]);
      }
      if (ch.has("out")) glide(output.gain, amp(v.out));
    },
  };
}

// ---- Auto Filter -------------------------------------------------------------------------
const FILTER_TYPES = ["Lowpass", "Highpass", "Bandpass", "Notch"];
const LFO_SHAPES = ["Sine", "Triangle", "Square", "Saw"];

function autoFilter(ctx) {
  const P = parts(ctx), io = P.wetDry(), pre = P.gain(1 / SPAN), shaper = ctx.createWaveShaper(), f1 = P.bq(), f2 = P.bq();
  const osc = P.lfo(), depth = P.gain(0);
  shaper.oversample = "2x";
  io.input.connect(pre).connect(shaper).connect(f1).connect(f2).connect(io.wet);
  osc.connect(depth); depth.connect(f1.detune); depth.connect(f2.detune);
  return {
    ...io, filters: [f1, f2],
    set(v, ch, bpm) {
      const kind = ["lowpass", "highpass", "bandpass", "notch"][v.type], steep = v.slope === 1, pass = v.type < 2;
      f1.type = kind; f2.type = steep ? kind : "peaking";
      glide(f1.Q, pass ? qdb(steep ? 0.5412 : v.res) : v.res);
      glide(f2.Q, pass ? qdb(v.res) : v.res);
      glide(f1.frequency, v.freq); glide(f2.frequency, v.freq);
      if (ch.has("drive")) {
        const a = amp(v.drive), k = Math.min(1, v.drive / 3);
        shaper.curve = curve((u) => u + (Math.tanh(a * u) - u) * k);
      }
      osc.type = ["sine", "triangle", "square", "sawtooth"][v.shape];
      glide(osc.frequency, v.sync ? bpm / 60 / beatsOf(v.div) : v.rate);
      glide(depth.gain, v.lfo * 3600);
      io.mix(v.mix);
    },
    dispose() { osc.stop(); },
  };
}

// ---- Saturator -------------------------------------------------------------------------
function saturator(ctx) {
  const P = parts(ctx), io = P.wetDry(), pre = P.gain(1 / SPAN), shaper = ctx.createWaveShaper(), dc = P.bq("highpass", 10), out = P.gain();
  shaper.oversample = "4x"; dc.Q.value = qdb(0.707);
  io.input.connect(pre).connect(shaper).connect(dc).connect(out).connect(io.wet);
  return {
    ...io,
    set(v, ch) {
      if (ch.has("type") || ch.has("drive")) { const a = amp(v.drive), fn = SHAPES[v.type]; shaper.curve = curve((u) => fn(a * u)); }
      glide(out.gain, amp(v.out));
      io.mix(v.mix);
    },
  };
}

// ---- Delay -------------------------------------------------------------------------------
// Left and right lines with a filter in each feedback path. Ping Pong feeds the input into the
// left line and crosses the feedback, so repeats bounce side to side. Freeze holds what's in it.
function delay(ctx) {
  const P = parts(ctx), io = P.wetDry(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const line = () => {
    const d = ctx.createDelay(8), hp = P.bq("highpass"), lp = P.bq("lowpass");
    d.connect(hp).connect(lp);
    return { d, hp, lp, same: P.gain(0), cross: P.gain(0) };
  };
  const L = line(), R = line(), inL = P.gain(1), inR = P.gain(1), inRL = P.gain(0);
  io.input.connect(split);
  split.connect(inL, 0); inL.connect(L.d);
  split.connect(inR, 1); inR.connect(R.d);
  split.connect(inRL, 1); inRL.connect(L.d);
  for (const [a, b] of [[L, R], [R, L]]) { a.lp.connect(a.same).connect(a.d); a.lp.connect(a.cross).connect(b.d); }
  L.lp.connect(merge, 0, 0); R.lp.connect(merge, 0, 1); merge.connect(io.wet);
  return {
    ...io,
    set(v, ch, bpm) {
      const secs = v.sync ? beatsOf(v.div) * 60 / bpm : v.time / 1000, fb = v.freeze ? 1 : v.fb;
      for (const s of [L, R]) {
        glide(s.d.delayTime, Math.min(8, secs), ch.has("bpm") || ch.has("sync") ? 0.012 : 0.06);  // a moved time glides, like tape
        glide(s.same.gain, v.pp ? 0 : fb); glide(s.cross.gain, v.pp ? fb : 0);
        glide(s.hp.frequency, v.lo); glide(s.lp.frequency, v.hi);
        s.hp.Q.value = s.lp.Q.value = qdb(0.707);
      }
      glide(inL.gain, v.freeze ? 0 : 1); glide(inR.gain, v.freeze || v.pp ? 0 : 1); glide(inRL.gain, !v.freeze && v.pp ? 1 : 0);
      io.mix(v.mix);
    },
  };
}

// ---- Reverb ------------------------------------------------------------------------------
// A convolution reverb whose impulse is grown from the settings: a decaying, darkening noise
// tail behind a cluster of early reflections. A changed impulse crossfades in, so turning a
// knob never cuts the tail off.
function impulse(ctx, { size, decay, damp, width }) {
  const sr = ctx.sampleRate, n = Math.ceil(sr * Math.min(24, decay * 1.2 + 0.05)), buf = ctx.createBuffer(2, n, sr);
  const ch = [buf.getChannelData(0), buf.getChannelData(1)], build = Math.max(1, sr * (0.002 + size * 0.04)), BLOCK = 64;
  const fall = Math.exp(-6.91 / (decay * sr)), darken = Math.exp(-2.5 * BLOCK / (decay * sr));  // per sample, and per block
  let seed = 22222, env = 1, bright = damp, a = 0;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed / 2147483648; };  // xorshift: fast, the same tail every time
  const lp = [0, 0];
  for (let i = 0; i < n; i++) {
    if (i % BLOCK === 0) { a = 1 - Math.exp(-2 * Math.PI * (200 + bright) / sr); bright *= darken; }  // the tail darkens as it falls
    const e = env * Math.min(1, i / build);
    env *= fall;
    for (let c = 0; c < 2; c++) { lp[c] += a * (rnd() - lp[c]); ch[c][i] = lp[c] * e; }
  }
  const spread = sr * (0.005 + size * 0.06);
  for (let r = 1; r <= 14; r++) {
    for (let c = 0; c < 2; c++) {
      const t = Math.min(n - 1, Math.floor(spread * r / 14 * (1 + 0.25 * rnd())));
      ch[c][t] += 0.35 * (1 - r / 16) * rnd();
    }
  }
  for (let i = 0; i < n; i++) { const m = (ch[0][i] + ch[1][i]) / 2, s = (ch[0][i] - ch[1][i]) / 2 * width; ch[0][i] = m + s; ch[1][i] = m - s; }
  return buf;
}

function reverb(ctx) {
  const P = parts(ctx), io = P.wetDry(), pre = ctx.createDelay(1), lo = P.bq("highpass"), hi = P.bq("lowpass");
  const slots = [0, 1].map(() => ({ conv: null, g: P.gain(0) }));
  io.input.connect(pre);
  for (const s of slots) s.g.connect(lo);
  lo.connect(hi).connect(io.wet);
  lo.Q.value = hi.Q.value = qdb(0.707);
  let live = 0, timer = 0, shape = "";
  const regrow = (v) => {
    const key = `${v.size}|${v.decay}|${v.damp}|${v.width}`;
    if (key === shape) return;
    shape = key; clearTimeout(timer);
    timer = setTimeout(() => {
      const next = slots[1 - live], old = slots[live];
      next.conv?.disconnect();
      next.conv = ctx.createConvolver(); next.conv.buffer = impulse(ctx, v);
      pre.connect(next.conv); next.conv.connect(next.g);
      glide(next.g.gain, 1, 0.04); glide(old.g.gain, 0, 0.04);
      live = 1 - live;
    }, shape.length && slots[live].conv ? 90 : 0);
  };
  return {
    ...io,
    set(v) {
      glide(pre.delayTime, v.pre / 1000);
      glide(lo.frequency, v.lo); glide(hi.frequency, v.hi);
      regrow(v); io.mix(v.mix);
    },
    dispose() { clearTimeout(timer); },
  };
}

// ---- Chorus and Phaser -------------------------------------------------------------------
// Chorus: two short delays swept in opposite directions; at a 1–3 ms delay with feedback it
// becomes a flanger.
function chorus(ctx) {
  const P = parts(ctx), io = P.wetDry(), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
  const osc = P.lfo(), dep = P.gain(0), inv = P.gain(-1), dl = ctx.createDelay(0.1), dr = ctx.createDelay(0.1), fl = P.gain(0), fr = P.gain(0);
  io.input.connect(split); split.connect(dl, 0); split.connect(dr, 1);
  osc.connect(dep); dep.connect(dl.delayTime); dep.connect(inv).connect(dr.delayTime);
  dl.connect(fl).connect(dl); dr.connect(fr).connect(dr);
  dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(io.wet);
  return {
    ...io,
    set(v) {
      const base = v.delay / 1000;
      glide(dl.delayTime, base); glide(dr.delayTime, base); glide(dep.gain, v.depth * base * 0.9);
      glide(osc.frequency, v.rate); glide(fl.gain, v.fb); glide(fr.gain, v.fb);
      io.mix(v.mix);
    },
    dispose() { osc.stop(); },
  };
}

// Phaser: a run of all-pass filters swept by an LFO, mixed with the dry sound to make notches
function phaser(ctx) {
  const P = parts(ctx), io = P.wetDry(), osc = P.lfo(), dep = P.gain(0), back = ctx.createDelay(0.01), fb = P.gain(0);
  const stages = Array.from({ length: 12 }, () => { const a = P.bq("allpass"); a.Q.value = 0.7; dep.connect(a.detune); return a; });
  osc.connect(dep); back.delayTime.value = 0; back.connect(fb);
  let poles = 0;
  const wire = (n) => {
    if (n === poles) return;
    for (const s of stages) s.disconnect();
    fb.disconnect();
    poles = n;
    let at = stages[0];
    for (let i = 1; i < n; i++) { at.connect(stages[i]); at = stages[i]; }
    at.connect(io.wet); at.connect(back); fb.connect(stages[0]);
  };
  io.input.connect(stages[0]);
  return {
    ...io,
    set(v) {
      wire([4, 8, 12][v.poles]);
      for (const s of stages) glide(s.frequency, v.freq);
      glide(dep.gain, v.depth * 3600); glide(osc.frequency, v.rate); glide(fb.gain, v.fb);
      io.mix(v.mix);
    },
    dispose() { osc.stop(); },
  };
}

// ---- the registry ------------------------------------------------------------------------
// view: the display drawn beside the knobs (views.js); tempo: follows the set's tempo
export const DEVICES = {
  eq: { name: "EQ Eight", cat: "EQ & Filters", view: "eq", build: eqEight,
    params: [...eqParams, db("out", "Output", -12, 12, 0)],
    help: "Eight bands of shelf, bell and cut. Drag a band's dot in the display; scroll on it for Q" },
  filter: { name: "Auto Filter", cat: "EQ & Filters", view: "filter", build: autoFilter, tempo: true,
    params: [{ k: "type", n: "Type", opts: FILTER_TYPES, def: 0 }, { k: "slope", n: "Slope", opts: ["12 dB", "24 dB"], def: 1 },
      hz("freq", "Freq", 20, 20000, 2000), { k: "res", n: "Res", min: 0.5, max: 12, def: 0.9, log: true },
      db("drive", "Drive", 0, 24, 0), pct("lfo", "LFO", 0), rate(1, free), { k: "div", n: "Rate", opts: DIV_NAMES, def: 6, when: synced },
      { k: "sync", n: "Sync", bool: true, def: false }, { k: "shape", n: "Shape", opts: LFO_SHAPES, def: 0 }, mixP(1)],
    help: "A resonant filter with drive and a tempo-synced LFO. Drag in the display to set Freq and Res" },
  comp: { name: "Compressor", cat: "Dynamics", view: "comp", build: worklet("crate-comp", 2), meter: "gr",
    params: [db("threshold", "Threshold", -60, 0, -20), { k: "ratio", n: "Ratio", min: 1, max: 40, def: 4, log: true, unit: ":1" },
      ms("attack", "Attack", 0.05, 200, 10), ms("release", "Release", 5, 2000, 100), db("knee", "Knee", 0, 24, 6),
      db("makeup", "Output", -12, 24, 0), { k: "rms", n: "Detect", opts: ["Peak", "RMS"], def: 0 }, mixP(1)],
    help: "Turns down what goes over the threshold. Dry/Wet below 100% is parallel compression" },
  gate: { name: "Gate", cat: "Dynamics", view: "gate", build: worklet("crate-gate"), meter: "open",
    params: [db("threshold", "Threshold", -80, 0, -40), db("ret", "Return", 0, 24, 3), ms("attack", "Attack", 0.02, 100, 0.1),
      { k: "hold", n: "Hold", min: 0, max: 500, def: 20, unit: "ms", curve: 2 }, ms("release", "Release", 1, 2000, 100),
      db("floor", "Floor", -80, 0, -80, { inf: true })],
    help: "Lets sound through only above the threshold. Return keeps it open until the level drops that much further" },
  limiter: { name: "Limiter", cat: "Dynamics", view: "limiter", build: worklet("crate-limiter"), meter: "gr",
    params: [db("gain", "Gain", 0, 24, 0), db("ceiling", "Ceiling", -24, 0, -0.3), ms("release", "Release", 1, 1000, 50)],
    help: "Nothing passes the ceiling. Looks 1.5 ms ahead, so peaks are caught without clipping" },
  sat: { name: "Saturator", cat: "Character", view: "sat", build: saturator,
    params: [{ k: "type", n: "Curve", opts: ["Soft", "Hard", "Tube", "Fold"], def: 0 }, db("drive", "Drive", 0, 36, 6), db("out", "Output", -24, 12, 0), mixP(1)],
    help: "Warmth to distortion. Oversampled, so high drive stays clean of aliasing" },
  redux: { name: "Redux", cat: "Character", build: worklet("crate-redux"),
    params: [{ k: "bits", n: "Bits", min: 1, max: 16, def: 16, step: 1, unit: "bits" }, { k: "down", n: "Downsample", min: 1, max: 40, def: 1, log: true, unit: "x" }, mixP(1)],
    help: "Fewer bits and a lower sample rate, for lo-fi grit" },
  delay: { name: "Delay", cat: "Space", build: delay, tempo: true,
    params: [{ k: "sync", n: "Sync", bool: true, def: true }, { k: "div", n: "Time", opts: DIV_NAMES, def: 4, when: synced }, { ...ms("time", "Time", 1, 2000, 375), when: free },
      pct("fb", "Feedback", 0.4, 0, 0.95), { k: "pp", n: "Ping Pong", bool: true, def: false },
      hz("lo", "Low cut", 20, 2000, 100), hz("hi", "High cut", 1000, 20000, 8000), { k: "freeze", n: "Freeze", bool: true, def: false }, mixP(0.35)],
    help: "Synced or free delay with filtered feedback, Ping Pong and Freeze" },
  reverb: { name: "Reverb", cat: "Space", view: "reverb", build: reverb,
    params: [ms("pre", "Pre-delay", 0.5, 250, 15), pct("size", "Size", 0.5), { k: "decay", n: "Decay", min: 0.2, max: 20, def: 2.2, log: true, unit: "s" },
      hz("damp", "Damping", 1000, 20000, 7000), hz("lo", "Low cut", 20, 1000, 120), hz("hi", "High cut", 1500, 20000, 12000), pct("width", "Width", 1), mixP(0.3)],
    help: "From small rooms to long halls. On a return track, set Dry/Wet to 100%" },
  chorus: { name: "Chorus", cat: "Modulation", build: chorus,
    params: [rate(0.5), ms("delay", "Delay", 0.5, 30, 8), pct("depth", "Amount", 0.4), pct("fb", "Feedback", 0, -0.9, 0.9), mixP(0.5)],
    help: "Two swept delays. Delay at 1–3 ms with feedback makes a flanger" },
  phaser: { name: "Phaser", cat: "Modulation", build: phaser,
    params: [{ k: "poles", n: "Poles", opts: ["4", "8", "12"], def: 1 }, hz("freq", "Freq", 100, 8000, 700), pct("depth", "Amount", 0.6), rate(0.4),
      pct("fb", "Feedback", 0.5, 0, 0.9), mixP(0.5)],
    help: "Swept notches. More poles, more notches" },
  utility: { name: "Utility", cat: "Utility", build: worklet("crate-utility"),
    params: [db("gain", "Gain", -35, 35, 0), { k: "width", n: "Width", min: 0, max: 4, def: 1, curve: 2, unit: "%" }, { k: "balance", n: "Balance", min: -1, max: 1, def: 0, unit: "pan" },
      { k: "mono", n: "Mono", bool: true, def: false }, { k: "flipL", n: "Phase L", bool: true, def: false }, { k: "flipR", n: "Phase R", bool: true, def: false },
      { k: "dc", n: "DC", bool: true, def: false }],
    help: "Gain, stereo width, balance, phase and a DC filter" },
};
for (const def of Object.values(DEVICES)) def.byKey = Object.fromEntries(def.params.map((p) => [p.k, p]));
export const CATEGORIES = ["Dynamics", "EQ & Filters", "Character", "Space", "Modulation", "Utility"];

// ---- instances ---------------------------------------------------------------------------
export function createDevice(ctx, type) {
  const def = DEVICES[type];
  if (!def) return null;
  return Object.assign(def.build(ctx), { def, last: {}, bpm: 0 });
}

// follows a device's stored settings; only what changed reaches the audio graph
export function applyDevice(inst, d, bpm) {
  const v = {}, changed = new Set();
  for (const p of inst.def.params) { v[p.k] = d.params?.[p.k] ?? p.def; if (inst.last[p.k] !== v[p.k]) changed.add(p.k); }
  if (inst.def.tempo && inst.bpm !== bpm) changed.add("bpm");
  if (!changed.size) return;
  inst.set(v, changed, bpm);
  inst.last = v; inst.bpm = bpm;
}

export function disposeDevice(inst) {
  try { inst.dispose?.(); inst.output.disconnect(); } catch { /* already gone */ }
}
