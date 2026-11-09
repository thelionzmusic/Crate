// The browser audio backend: Crate's engine running inside the page on Web Audio.
// Works everywhere with no install; the native backend (native.js) is the low-latency option.
// Both expose the same methods, so engine.js never knows which one it's driving.

import { FxSlot } from "./fx.js";

const XOVER_LO = 220, XOVER_HI = 2600;
const BUTTER_DB = 20 * Math.log10(Math.SQRT1_2);  // Web Audio's low/high-pass Q is in dB: this is Butterworth
const POS = 0, PLAYING = 2, TIME = 3, TARGET = 4;

// one mixer channel as audio nodes
class Strip {
  constructor(ctx, input) {
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q = BUTTER_DB) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
    const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n; };
    this.ctx = ctx; this.trim = g(); this.sum = g();
    // Linkwitz-Riley 4th order = two Butterworth biquads in series; the three bands sum flat
    const lo = chain(bq("lowpass", XOVER_LO), bq("lowpass", XOVER_LO)), hi = chain(bq("highpass", XOVER_HI), bq("highpass", XOVER_HI));
    const mid = chain(bq("highpass", XOVER_LO), bq("highpass", XOVER_LO), bq("lowpass", XOVER_HI), bq("lowpass", XOVER_HI));
    this.bands = { low: g(), mid: g(), high: g() };
    for (const [nodes, k] of [[lo, "low"], [mid, "mid"], [hi, "high"]]) { this.trim.connect(nodes[0]); nodes.at(-1).connect(this.bands[k]); this.bands[k].connect(this.sum); }
    this.hpf = bq("highpass", 10, 1.1); this.lpf = bq("lowpass", 22000, 1.1);
    this.pre = g(); this.cue = g(0); this.fader = g(); this.xf = g();
    this.meter = new Meter(ctx);
    this.slots = [new FxSlot(ctx), new FxSlot(ctx)];
    chain(this.sum, this.hpf, this.lpf, this.slots[0].in); this.slots[0].out.connect(this.slots[1].in);
    chain(this.slots[1].out, this.pre, this.fader, this.xf);
    this.pre.connect(this.meter.node); this.pre.connect(this.cue);
    this.input = input; input.connect(this.trim);
  }
  param(k) {
    return { trim: this.trim.gain, low: this.bands.low.gain, mid: this.bands.mid.gain, high: this.bands.high.gain,
      hpf: this.hpf.frequency, lpf: this.lpf.frequency, fader: this.fader.gain, cue: this.cue.gain, xf: this.xf.gain }[k];
  }
}

// peak over the last block of samples; reads reuse one buffer
class Meter {
  constructor(ctx) { this.node = ctx.createAnalyser(); this.node.fftSize = 512; this.buf = new Float32Array(512); }
  peak() { this.node.getFloatTimeDomainData(this.buf); let p = 0; for (let i = 0; i < 512; i++) { const a = Math.abs(this.buf[i]); if (a > p) p = a; } return p; }
}

export class WebBackend {
  constructor() { this.kind = "web"; this.decks = []; this.strips = []; }

  async start(opts = {}) {
    this.ctx = new AudioContext({ latencyHint: opts.latency === "safe" ? 0.04 : "interactive" });
    await Promise.all(["./deck.worklet.js", "./fx.worklet.js"].map((f) => this.ctx.audioWorklet.addModule(new URL(f, import.meta.url))));
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.xfBus = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    Object.entries({ threshold: -1, knee: 0, ratio: 20, attack: 0.001, release: 0.12 }).forEach(([k, v]) => { this.limiter[k].value = v; });
    this.masterMeter = new Meter(ctx);
    this.cueBus = ctx.createGain(); this.phonesCue = ctx.createGain(); this.phonesMaster = ctx.createGain(); this.phones = ctx.createGain();
    this.cueBus.connect(this.phonesCue); this.phonesCue.connect(this.phones); this.phonesMaster.connect(this.phones);
    this.xfBus.connect(this.master); this.master.connect(this.limiter); this.limiter.connect(this.masterMeter.node); this.limiter.connect(this.phonesMaster);
    this.mixParams = { master: this.master.gain, phonesCue: this.phonesCue.gain, phonesMaster: this.phonesMaster.gain, phones: this.phones.gain };
  }
  async resume() { if (this.ctx.state === "suspended") await this.ctx.resume(); }
  now() { return this.ctx.currentTime; }
  get latency() { return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0); }
  get sampleRate() { return this.ctx.sampleRate; }
  status() { return { latency: this.latency }; }

  // a deck's player on the audio thread; position and rate shared through `sh`
  deckPort(i, onEnded) {
    const shared = globalThis.crossOriginIsolated;
    const sh = new Float64Array(shared ? new SharedArrayBuffer(64) : new ArrayBuffer(64));
    sh[TARGET] = 1;
    const node = new AudioWorkletNode(this.ctx, "crate-deck", { numberOfInputs: 0, outputChannelCount: [2], processorOptions: { shared: shared ? sh.buffer : null } });
    node.port.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "state") sh.set(m.s);
      else if (m.type === "ended") onEnded();
    };
    const strip = new Strip(this.ctx, node);
    strip.xf.connect(this.xfBus); strip.cue.connect(this.cueBus);
    this.decks[i] = node; this.strips[i] = strip;
    return { sh, shared, post: (m, transfer) => node.port.postMessage(m, transfer || []) };
  }

  // fetch and decode on the page, hand the samples to the deck; returns the length in frames
  async loadTrack(i, track, atSeconds, port) {
    const buf = await fetch(`/api/audio/${track.id}`)
      .then((r) => { if (!r.ok) throw new Error("The file is missing or can't be read"); return r.arrayBuffer(); })
      .then((b) => this.ctx.decodeAudioData(b));
    const pcm = interleave(buf), at = atSeconds * this.sampleRate;
    port.sh[POS] = at; port.sh[PLAYING] = 0; port.sh[TIME] = this.now();
    port.post({ type: "load", pcm, at }, [pcm.buffer]);
    return buf.length;
  }

  setParam(i, k, v) { this.strips[i].param(k).setTargetAtTime(v, this.ctx.currentTime, 0.012); }
  setMix(k, v) { this.mixParams[k].setTargetAtTime(v, this.ctx.currentTime, 0.012); }
  applyFx(i, slot, state, active, bpm) { this.strips[i].slots[slot].apply(state, active, bpm); }
  peak(i) { return this.strips[i].meter.peak(); }
  masterPeak() { return this.masterMeter.peak(); }

  // headphones: "off" | "34" (channels 3-4 of the same device) | another device id
  // mixing: "internal" | "external" (deck A -> 1/2, B -> 3/4, C -> 5/6, D -> 7/8)
  async route({ device = "", headphones = "off", mixing = "internal" } = {}, onError = () => {}) {
    const ctx = this.ctx, dest = ctx.destination;
    try { if (ctx.setSinkId && (ctx.sinkId || "") !== device) await ctx.setSinkId(device); } catch (e) { onError(`Couldn't use that output: ${e.message}`); }
    for (const n of [this.merger, this.masterMeter.node, this.phones, ...this.decks]) { try { n && n.disconnect(); } catch { /* not connected */ } }
    this.decks.forEach((d, i) => d.connect(this.strips[i].trim));
    if (this.phonesCtx) { this.phonesCtx.close(); this.phonesCtx = null; }
    const max = dest.maxChannelCount, want = mixing === "external" ? Math.min(max, 8) : headphones === "34" && max >= 4 ? 4 : 2;
    dest.channelCount = want; dest.channelCountMode = "explicit"; dest.channelInterpretation = want > 2 ? "discrete" : "speakers";
    this.merger = ctx.createChannelMerger(want); this.merger.connect(dest);
    const pair = (node, at) => { const sp = ctx.createChannelSplitter(2); node.connect(sp); sp.connect(this.merger, 0, at); sp.connect(this.merger, 1, at + 1); };
    this.outputs = { mixing, headphones, channels: want };
    if (mixing === "external") { this.decks.forEach((d, i) => { if (2 * i + 1 < want) pair(d, 2 * i); }); return; }
    pair(this.masterMeter.node, 0);
    if (headphones === "34" && want >= 4) pair(this.phones, 2);
    else if (headphones && headphones !== "off" && headphones !== "34") {
      // a separate headphone device gets its own context, fed through a media stream
      const out = ctx.createMediaStreamDestination(); this.phones.connect(out);
      this.phonesCtx = new AudioContext({ latencyHint: "interactive" });
      try { await this.phonesCtx.setSinkId(headphones); } catch (e) { onError(`Couldn't use the headphone output: ${e.message}`); }
      this.phonesCtx.createMediaStreamSource(out.stream).connect(this.phonesCtx.destination);
    }
  }
}

// decoded audio -> interleaved 16-bit stereo, half the memory of floats
function interleave(buf) {
  const n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, pcm = new Int16Array(n * 2);
  for (let i = 0; i < n; i++) { const l = L[i], r = R[i]; pcm[2 * i] = (l > 1 ? 1 : l < -1 ? -1 : l) * 32767; pcm[2 * i + 1] = (r > 1 ? 1 : r < -1 ? -1 : r) * 32767; }
  return pcm;
}
