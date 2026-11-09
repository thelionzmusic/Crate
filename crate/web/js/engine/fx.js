// Built-in effects, made from native Web Audio nodes (plus one small worklet for the
// crusher), so they cost almost nothing on the audio thread.
//
// Every effect exposes the same shape: input, output, update({ p1, p2, beats, bpm }), dispose().
// p1 and p2 are 0..1; beats is the musical length (delay time, LFO cycle) and bpm the
// deck's current tempo, so timed effects stay locked to the track.
//
// Two kinds:
//   send    the effect is added on top of the dry signal and its tail rings out when you
//           switch it off (echo, reverb), the way DJ mixers behave
//   insert  the effect replaces the dry signal in proportion to dry/wet, and switching it
//           off returns the dry signal instantly (flanger, gater...)

const T = 0.02;  // parameter smoothing, seconds
const ramp = (ctx, p, v) => p.setTargetAtTime(v, ctx.currentTime, T);
const beatSec = (beats, bpm) => beats * 60 / (bpm || 120);
const hz = (lo, hi, k) => lo * (hi / lo) ** k;  // exponential sweep for frequency knobs

function lfo(ctx, type = "sine") {
  const o = ctx.createOscillator(), depth = ctx.createGain();
  o.type = type; o.connect(depth); o.start();
  return { o, depth, dispose() { o.stop(); o.disconnect(); depth.disconnect(); } };
}

export const EFFECTS = {
  echo: {
    label: "Echo", kind: "send", p1: "Feedback", p2: "Tone", beats: 0.75,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), d = ctx.createDelay(8), lp = ctx.createBiquadFilter(), fb = ctx.createGain();
      lp.type = "lowpass";
      input.connect(d); d.connect(lp); lp.connect(fb); fb.connect(d); lp.connect(output);
      return { input, output,
        update: ({ p1, p2, beats, bpm }) => { ramp(ctx, d.delayTime, beatSec(beats, bpm)); ramp(ctx, fb.gain, p1 * 0.88); ramp(ctx, lp.frequency, hz(900, 16000, p2)); },
        dispose: () => [input, d, lp, fb, output].forEach((n) => n.disconnect()) };
    },
  },
  pingpong: {
    label: "Ping pong", kind: "send", p1: "Feedback", p2: "Tone", beats: 0.5,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), mono = ctx.createGain(), dl = ctx.createDelay(8), dr = ctx.createDelay(8);
      const fb = ctx.createGain(), lp = ctx.createBiquadFilter(), merge = ctx.createChannelMerger(2);
      mono.channelCount = 1; mono.channelCountMode = "explicit"; lp.type = "lowpass";
      // left repeats into right, right back into left through the feedback gain
      input.connect(mono); mono.connect(dl); dl.connect(dr); dr.connect(lp); lp.connect(fb); fb.connect(dl);
      dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); merge.connect(output);
      return { input, output,
        update: ({ p1, p2, beats, bpm }) => { const t = beatSec(beats, bpm); ramp(ctx, dl.delayTime, t); ramp(ctx, dr.delayTime, t); ramp(ctx, fb.gain, p1 * 0.85); ramp(ctx, lp.frequency, hz(900, 16000, p2)); },
        dispose: () => [input, mono, dl, dr, fb, lp, merge, output].forEach((n) => n.disconnect()) };
    },
  },
  reverb: {
    label: "Reverb", kind: "send", p1: "Size", p2: "Tone", beats: null,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), conv = ctx.createConvolver(), lp = ctx.createBiquadFilter();
      lp.type = "lowpass"; input.connect(conv); conv.connect(lp); lp.connect(output);
      let size = -1;
      return { input, output,
        update: ({ p1, p2 }) => {
          ramp(ctx, lp.frequency, hz(1500, 16000, p2));
          const want = Math.round(p1 * 20) / 20;  // rebuild the room only when the size really changes
          if (want !== size) { size = want; conv.buffer = room(ctx, 0.6 + want * 5.4); }
        },
        dispose: () => [input, conv, lp, output].forEach((n) => n.disconnect()) };
    },
  },
  flanger: {
    label: "Flanger", kind: "insert", p1: "Depth", p2: "Feedback", beats: 8,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), d = ctx.createDelay(0.05), fb = ctx.createGain(), m = lfo(ctx);
      d.delayTime.value = 0.004; m.depth.connect(d.delayTime);
      input.connect(d); d.connect(fb); fb.connect(d); input.connect(output); d.connect(output);
      return { input, output,
        update: ({ p1, p2, beats, bpm }) => { ramp(ctx, m.o.frequency, 1 / beatSec(beats, bpm)); ramp(ctx, m.depth.gain, 0.0005 + p1 * 0.0032); ramp(ctx, fb.gain, p2 * 0.85); },
        dispose: () => { m.dispose(); [input, d, fb, output].forEach((n) => n.disconnect()); } };
    },
  },
  phaser: {
    label: "Phaser", kind: "insert", p1: "Depth", p2: "Resonance", beats: 4,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), m = lfo(ctx), stages = [];
      let prev = input;
      for (let i = 0; i < 6; i++) { const a = ctx.createBiquadFilter(); a.type = "allpass"; a.frequency.value = 700; m.depth.connect(a.frequency); prev.connect(a); prev = a; stages.push(a); }
      input.connect(output); prev.connect(output);  // the phase-shifted copy against the dry: notches sweep
      return { input, output,
        update: ({ p1, p2, beats, bpm }) => { ramp(ctx, m.o.frequency, 1 / beatSec(beats, bpm)); ramp(ctx, m.depth.gain, 100 + p1 * 600); stages.forEach((a) => ramp(ctx, a.Q, 0.3 + p2 * 6)); },
        dispose: () => { m.dispose(); [input, ...stages, output].forEach((n) => n.disconnect()); } };
    },
  },
  gater: {
    label: "Gater", kind: "insert", p1: "Depth", p2: "Smooth", beats: 0.25,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), vca = ctx.createGain(), m = lfo(ctx, "square"), smooth = ctx.createBiquadFilter();
      smooth.type = "lowpass";
      m.o.disconnect(); m.o.connect(smooth); smooth.connect(m.depth); m.depth.connect(vca.gain);
      input.connect(vca); vca.connect(output);
      return { input, output,
        update: ({ p1, p2, beats, bpm }) => { ramp(ctx, m.o.frequency, 1 / beatSec(beats, bpm)); ramp(ctx, vca.gain, 1 - p1 / 2); ramp(ctx, m.depth.gain, p1 / 2); ramp(ctx, smooth.frequency, hz(2000, 15, p2)); },
        dispose: () => { m.dispose(); [input, vca, smooth, output].forEach((n) => n.disconnect()); } };
    },
  },
  crusher: {
    label: "Crusher", kind: "insert", p1: "Bits", p2: "Rate", beats: null,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), node = new AudioWorkletNode(ctx, "crate-crush", { outputChannelCount: [2] });
      input.connect(node); node.connect(output);
      const bits = node.parameters.get("bits"), hold = node.parameters.get("hold");
      return { input, output,
        update: ({ p1, p2 }) => { ramp(ctx, bits, 16 - p1 * 13); ramp(ctx, hold, 1 + Math.round(p2 * 30)); },
        dispose: () => [input, node, output].forEach((n) => n.disconnect()) };
    },
  },
  autofilter: {
    label: "Auto filter", kind: "insert", p1: "Depth", p2: "Resonance", beats: 2,
    build(ctx) {
      const input = ctx.createGain(), output = ctx.createGain(), f = ctx.createBiquadFilter(), m = lfo(ctx);
      f.type = "lowpass"; f.frequency.value = 1400; m.depth.connect(f.frequency);
      input.connect(f); f.connect(output);
      return { input, output,
        update: ({ p1, p2, beats, bpm }) => { ramp(ctx, m.o.frequency, 1 / beatSec(beats, bpm)); ramp(ctx, m.depth.gain, 100 + p1 * 1250); ramp(ctx, f.Q, 0.7 + p2 * 14); },
        dispose: () => { m.dispose(); [input, f, output].forEach((n) => n.disconnect()); } };
    },
  },
};
export const FX_ORDER = ["echo", "pingpong", "reverb", "flanger", "phaser", "gater", "crusher", "autofilter"];
export const BEATS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16];

// a synthetic room: decaying stereo noise, brighter at the start, darker in the tail
function room(ctx, seconds) {
  const sr = ctx.sampleRate, n = Math.round(sr * seconds), buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch); let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n, env = Math.pow(1 - t, 2.2) * Math.exp(-3 * t), k = 0.15 + 0.8 * t;  // more smoothing later on
      lp += (Math.random() * 2 - 1 - lp) * (1 - k);
      d[i] = lp * env * 0.5;
    }
  }
  return buf;
}

// One effect slot in a channel: dry path, send into the effect, wet return.
export class FxSlot {
  constructor(ctx) {
    this.ctx = ctx; this.type = null; this.fx = null; this.last = null;
    this.in = ctx.createGain(); this.out = ctx.createGain(); this.dry = ctx.createGain(); this.send = ctx.createGain(); this.wet = ctx.createGain();
    this.send.gain.value = 0; this.wet.gain.value = 0;
    this.in.connect(this.dry); this.dry.connect(this.out); this.in.connect(this.send); this.wet.connect(this.out);
  }
  // state: { type, on, mix, p1, p2, beats } from the unit; active: this channel is assigned
  apply(state, active, bpm) {
    if (state.type !== this.type) {
      if (this.fx) { this.send.disconnect(); this.fx.output.disconnect(); this.fx.dispose(); }
      this.type = state.type; this.fx = EFFECTS[state.type].build(this.ctx);
      this.send.connect(this.fx.input); this.fx.output.connect(this.wet); this.last = null;
    }
    const def = EFFECTS[this.type], on = state.on && active, r = (p, v) => ramp(this.ctx, p, v);
    if (def.kind === "send") { r(this.dry.gain, 1); r(this.send.gain, on ? 1 : 0); r(this.wet.gain, state.mix); }  // tails ring out after off
    else { r(this.dry.gain, on ? Math.cos(state.mix * Math.PI / 2) : 1); r(this.send.gain, on ? 1 : 0); r(this.wet.gain, on ? Math.sin(state.mix * Math.PI / 2) : 0); }
    const key = `${state.p1}|${state.p2}|${state.beats}|${bpm.toFixed(2)}`;
    if (key !== this.last) { this.last = key; this.fx.update({ p1: state.p1, p2: state.p2, beats: state.beats ?? 1, bpm }); }
  }
}
