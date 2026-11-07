// Crate's DJ engine: decks, mixer, sync and outputs. No DOM in here; the Performance
// view and (later) hardware mappings drive it through the same methods.
//
// Signal per channel:
//   deck -> trim -> 3-band isolator (LR4 crossovers at 220 Hz / 2.6 kHz) -> filter
//        -> [pre-fader: meter, headphone cue] -> channel fader -> crossfader -> master
// Master runs through a brick-wall safety limiter at -1 dBTP-ish so nothing ever clips.
// "External mixer" mode skips all of that and sends each deck to its own output pair,
// for a DJM with a USB soundcard.

const XOVER_LO = 220, XOVER_HI = 2600;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const DECK_IDS = ["A", "B", "C", "D"];
export const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
export const RANGES = [0.06, 0.1, 0.16, 0.5];

// ---------- beat grid: constant tempo, or the per-beat list for tracks that drift
export class Grid {
  constructor(t) {
    this.bpm = t.bpm || 0; this.t0 = (t.first_beat_ms || 0) / 1000; this.db = t.downbeat || 0;
    this.b = t.beats && t.beats.length > 1 ? Float64Array.from(t.beats, (ms) => ms / 1000) : null;
  }
  get ok() { return this.bpm > 0; }
  index(s) {  // fractional beat number at time s
    const b = this.b; if (!b) return (s - this.t0) * this.bpm / 60;
    const n = b.length;
    if (s < b[0]) return (s - b[0]) / (b[1] - b[0]);
    if (s >= b[n - 1]) return n - 1 + (s - b[n - 1]) / (b[n - 1] - b[n - 2]);
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m] <= s) lo = m; else hi = m; }
    return lo + (s - b[lo]) / (b[hi] - b[lo]);
  }
  time(i) {  // time of (fractional) beat i
    const b = this.b; if (!b) return this.t0 + i * 60 / this.bpm;
    const n = b.length, k = clamp(Math.floor(i), 0, n - 2);
    return b[k] + (i - k) * (b[k + 1] - b[k]);
  }
  period(s) { const i = this.index(s); return this.time(Math.floor(i) + 1) - this.time(Math.floor(i)); }
  bar(i) { return Math.floor((Math.round(i) - this.db) / 4); }
  isDownbeat(i) { return ((Math.round(i) - this.db) % 4 + 4) % 4 === 0; }
}

// ---------- one deck, as the main thread sees it
class Deck {
  constructor(engine, id) {
    this.e = engine; this.id = id; this.t = null; this.grid = null; this.wave = null; this.cues = [];
    this.frames = 0; this.pos = 0; this.repT = 0; this.rate = 1; this.playing = false;
    this.tempo = 0; this.range = 0.1; this.keylock = true; this.sync = false; this.nudge = 0; this.correction = 0;
    this.cueAt = 0; this.previewing = false; this.loop = null; this.loopBeats = 4; this.lastLoop = null; this.loading = false;
    this.node = new AudioWorkletNode(engine.ctx, "crate-deck", { numberOfInputs: 0, outputChannelCount: [2] });
    this.node.port.onmessage = (ev) => this.onMsg(ev.data);
    this.post({ type: "keylock", on: this.keylock });
  }
  post(m, transfer) { this.node.port.postMessage(m, transfer || []); }
  onMsg(m) {
    if (m.type === "pos") { this.pos = m.pos; this.repT = m.t; this.rateNow = m.rate; this.playing = m.playing; }
    else if (m.type === "ended") { this.playing = false; this.e.emit("deck", this); }
  }
  get loaded() { return !!this.t && !this.loading; }
  get sr() { return this.e.ctx.sampleRate; }
  get duration() { return this.frames / this.sr; }
  // audible position in seconds, extrapolated between reports and shifted by output latency
  time(audible = true) {
    let f = this.pos;
    if (this.playing) f += (this.e.ctx.currentTime - this.repT) * this.sr * (this.rateNow || this.rate);
    let s = f / this.sr;
    if (audible && this.playing) s -= this.e.latency * this.rate;
    return clamp(s, 0, this.duration);
  }
  get baseRate() { return 1 + this.tempo * this.range; }
  get bpm() { return this.grid && this.grid.ok ? this.grid.bpm * this.baseRate : 0; }
  applyRate(now = false) {
    this.rate = Math.max(0.05, this.baseRate * (1 + this.nudge) * (1 + this.correction));
    this.post({ type: "rate", rate: this.rate, now });
  }
  setTempo(v) { this.tempo = clamp(v, -1, 1); if (this.sync && this.e.leader() !== this) this.sync = false; this.applyRate(); this.e.emit("deck", this); }
  seek(s) { this.pos = clamp(s, 0, this.duration) * this.sr; this.repT = this.e.ctx.currentTime; this.post({ type: "seek", frame: this.pos }); }
  // jump while keeping the beat phase, so quantised cues and jumps land in time
  seekQuantised(s) {
    if (!this.e.quantise || !this.grid || !this.grid.ok || !this.playing) return this.seek(s);
    const now = this.time(false), g = this.grid, frac = g.index(now) - Math.floor(g.index(now));
    this.seek(g.time(Math.round(g.index(s)) + frac));
  }
  snap(s) { if (!this.e.quantise || !this.grid || !this.grid.ok) return s; return this.grid.time(Math.round(this.grid.index(s))); }

  play() {
    if (!this.loaded) return;
    this.previewing = false;
    if (this.sync) this.e.alignPhase(this);
    this.post({ type: "play" }); this.playing = true; this.repT = this.e.ctx.currentTime;
    this.e.claimLeader(this); this.e.emit("deck", this);
  }
  pause() { this.post({ type: "pause" }); this.playing = false; this.e.emit("deck", this); }
  togglePlay() { this.playing ? this.pause() : this.play(); }

  // CDJ cue: playing -> back to cue and stop. Paused -> set cue here, and preview while held.
  cueDown() {
    if (!this.loaded) return;
    if (this.playing && !this.previewing) { this.pause(); this.seek(this.cueAt); return; }
    const here = this.time(false);
    if (Math.abs(here - this.cueAt) > 0.002) { this.cueAt = this.snap(here); this.seek(this.cueAt); }
    this.previewing = true; this.post({ type: "play" }); this.playing = true; this.repT = this.e.ctx.currentTime;
  }
  cueUp() { if (this.previewing) { this.previewing = false; this.pause(); this.seek(this.cueAt); } }

  hotCue(slot, del = false) {
    if (!this.loaded) return;
    const c = this.cues.find((x) => x.slot === slot);
    if (del) { if (c) { this.cues = this.cues.filter((x) => x !== c); this.e.saveCues(this); } return; }
    if (c) { const s = c.start_ms / 1000; this.playing ? this.seekQuantised(s) : (this.seek(s), this.play()); return; }
    this.cues.push({ slot, start_ms: Math.round(this.snap(this.time(false)) * 1000), end_ms: -1, color: null, name: "" });
    this.e.saveCues(this);
  }

  // ---- loops, in beats
  sendLoop() { this.post({ type: "loop", loop: this.loop ? [this.loop[0] * this.sr, this.loop[1] * this.sr] : null }); this.e.emit("deck", this); }
  loopToggle(beats = this.loopBeats) {
    if (!this.loaded || !this.grid || !this.grid.ok) return;
    if (this.loop) { this.lastLoop = this.loop; this.loop = null; return this.sendLoop(); }
    const g = this.grid, i = this.e.quantise ? Math.floor(g.index(this.time(false)) + 1e-6) : g.index(this.time(false));
    this.loopBeats = beats; this.loop = [g.time(i), g.time(i + beats)]; this.sendLoop();
  }
  loopResize(factor) {
    const k = LOOP_SIZES.indexOf(this.loopBeats) + (factor > 1 ? 1 : -1);
    if (k < 0 || k >= LOOP_SIZES.length) return;
    this.loopBeats = LOOP_SIZES[k];
    if (this.loop) { const g = this.grid, i = g.index(this.loop[0]); this.loop = [this.loop[0], g.time(i + this.loopBeats)]; this.sendLoop(); }
    else this.e.emit("deck", this);
  }
  reloop() { if (!this.lastLoop) return; this.loop = this.lastLoop; this.sendLoop(); this.seekQuantised(this.loop[0]); if (!this.playing) this.play(); }
  beatJump(beats) {
    if (!this.loaded || !this.grid || !this.grid.ok) return;
    const g = this.grid, now = this.time(false), target = g.time(g.index(now) + beats);
    if (this.loop) { const d = target - now; this.loop = [this.loop[0] + d, this.loop[1] + d]; this.sendLoop(); }
    this.seek(target);
  }
  setKeylock(on) { this.keylock = on; this.post({ type: "keylock", on }); this.e.emit("deck", this); }
  setSync(on) {
    this.sync = on && !!this.grid && this.grid.ok;
    if (this.sync) { const L = this.e.leader(); if (L && L !== this) { this.matchTempo(L); if (this.playing) this.e.alignPhase(this); } else this.e.leaderId = this.id; }
    else this.correction = 0;
    this.applyRate(); this.e.emit("deck", this);
  }
  // follow the leader's tempo, picking half or double time when that's closer
  matchTempo(L) {
    if (!this.grid || !this.grid.ok || !L.bpm) return;
    let r = L.bpm / this.grid.bpm; const opts = [r, r * 2, r / 2]; r = opts.reduce((a, b) => (Math.abs(b - 1) < Math.abs(a - 1) ? b : a));
    if (Math.abs(r - 1) > this.range) this.range = RANGES.find((x) => Math.abs(r - 1) <= x) || RANGES.at(-1);
    this.tempo = clamp((r - 1) / this.range, -1, 1);
  }
}

// ---------- mixer channel
class Channel {
  constructor(ctx, deck) {
    const g = (v = 1) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = Math.SQRT1_2; return n; };
    const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n; };
    this.ctx = ctx; this.trim = g(); this.sum = g();
    // Linkwitz-Riley 4th order = two Butterworth biquads in series; the three bands sum flat
    const lo = chain(bq("lowpass", XOVER_LO), bq("lowpass", XOVER_LO)), hi = chain(bq("highpass", XOVER_HI), bq("highpass", XOVER_HI));
    const mid = chain(bq("highpass", XOVER_LO), bq("highpass", XOVER_LO), bq("lowpass", XOVER_HI), bq("lowpass", XOVER_HI));
    this.bands = { low: g(), mid: g(), high: g() };
    for (const [nodes, k] of [[lo, "low"], [mid, "mid"], [hi, "high"]]) { this.trim.connect(nodes[0]); nodes.at(-1).connect(this.bands[k]); this.bands[k].connect(this.sum); }
    this.hp = bq("highpass", 10); this.lp = bq("lowpass", 22000); this.hp.Q.value = this.lp.Q.value = 1.1;
    this.pre = g(); this.cue = g(0); this.fader = g(); this.xf = g();
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512; this.meterBuf = new Float32Array(512);
    chain(this.sum, this.hp, this.lp, this.pre, this.fader, this.xf);
    this.pre.connect(this.meter); this.pre.connect(this.cue);
    deck.node.connect(this.trim);
    this.v = { trim: 0.5, high: 0.5, mid: 0.5, low: 0.5, filter: 0.5, fader: 1, cue: 0 }; this.auto = 0;
  }
  ramp(p, v) { p.setTargetAtTime(v, this.ctx.currentTime, 0.012); }
  set(k, v) {
    v = clamp(v, 0, 1); this.v[k] = v;
    if (k === "trim") this.ramp(this.trim.gain, 10 ** ((this.auto + (v - 0.5) * 24) / 20));
    else if (k in this.bands) this.ramp(this.bands[k].gain, v <= 0.5 ? (v / 0.5) ** 2 : 1 + (v - 0.5) * 2);   // kill .. +6 dB
    else if (k === "filter") {  // left: low-pass sweep, right: high-pass sweep, centre: open
      const d = v - 0.5;
      this.ramp(this.lp.frequency, d < -0.02 ? 80 * (22000 / 80) ** ((d + 0.5) / 0.48) : 22000);
      this.ramp(this.hp.frequency, d > 0.02 ? 10 * (9000 / 10) ** ((d - 0.02) / 0.48) : 10);
    } else if (k === "fader") this.ramp(this.fader.gain, v * v);
    else if (k === "cue") this.ramp(this.cue.gain, v);
  }
  setAuto(db) { this.auto = db; this.set("trim", this.v.trim); }
  level() { this.meter.getFloatTimeDomainData(this.meterBuf); let p = 0; for (const x of this.meterBuf) { const a = Math.abs(x); if (a > p) p = a; } return p; }
}

// ---------- the engine
export class Engine {
  constructor() { this.listeners = new Set(); this.decks = []; this.channels = []; this.quantise = true; this.leaderId = null; this.ready = null; }

  async start(opts = {}) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      this.ctx = new AudioContext({ latencyHint: opts.latency === "safe" ? 0.04 : "interactive" });
      await this.ctx.audioWorklet.addModule("engine/deck.worklet.js");
      const ctx = this.ctx;
      this.master = ctx.createGain(); this.xfBus = ctx.createGain();
      this.limiter = ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
      this.limiter.attack.value = 0.001; this.limiter.release.value = 0.12;
      this.masterMeter = ctx.createAnalyser(); this.masterMeter.fftSize = 512; this.masterBuf = new Float32Array(512);
      this.cueBus = ctx.createGain(); this.phonesCue = ctx.createGain(); this.phonesMaster = ctx.createGain(); this.phones = ctx.createGain();
      this.cueBus.connect(this.phonesCue); this.phonesCue.connect(this.phones); this.phonesMaster.connect(this.phones);
      this.xfBus.connect(this.master); this.master.connect(this.limiter); this.limiter.connect(this.masterMeter); this.limiter.connect(this.phonesMaster);
      for (const id of DECK_IDS) {
        const d = new Deck(this, id), ch = new Channel(ctx, d);
        ch.xf.connect(this.xfBus); ch.cue.connect(this.cueBus);
        this.decks.push(d); this.channels.push(ch);
      }
      this.mix = { xfader: 0.5, master: 0.8, phonesMix: 0.3, phonesVol: 0.8 };
      for (const [k, v] of Object.entries(this.mix)) this.set(k, v);
      await this.route(opts);
      this.timer = setInterval(() => this.tick(), 40);
      return this;
    })();
    return this.ready;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, x) { for (const fn of this.listeners) fn(kind, x); }
  get latency() { return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0); }
  deck(id) { return this.decks[DECK_IDS.indexOf(id)]; }
  channel(id) { return this.channels[DECK_IDS.indexOf(id)]; }

  // ---- outputs
  // headphones: "off" | "34" (channels 3-4 of the same device) | a device id
  // mixing: "internal" | "external" (deck A -> 1/2, B -> 3/4, C -> 5/6, D -> 7/8)
  async route({ device = "", headphones = "off", mixing = "internal" } = {}) {
    const ctx = this.ctx, dest = ctx.destination;
    try { if (ctx.setSinkId && (ctx.sinkId || "") !== device) await ctx.setSinkId(device); } catch (e) { this.emit("error", `Couldn't use that output: ${e.message}`); }
    if (this.merger) this.merger.disconnect();
    for (const n of [this.masterMeter, this.phones, ...this.decks.map((d) => d.node)]) { try { n.disconnect(); } catch { /* not connected */ } }
    for (const [d, ch] of this.decks.map((d, i) => [d, this.channels[i]])) d.node.connect(ch.trim);
    if (this.phonesCtx) { this.phonesCtx.close(); this.phonesCtx = null; }
    const max = dest.maxChannelCount;
    const want = mixing === "external" ? Math.min(max, 8) : headphones === "34" && max >= 4 ? 4 : 2;
    dest.channelCount = want; dest.channelCountMode = "explicit"; dest.channelInterpretation = want > 2 ? "discrete" : "speakers";
    this.merger = ctx.createChannelMerger(want); this.merger.connect(dest);
    const pair = (node, at) => { const sp = ctx.createChannelSplitter(2); node.connect(sp); sp.connect(this.merger, 0, at); sp.connect(this.merger, 1, at + 1); };
    if (mixing === "external") {
      this.decks.forEach((d, i) => { if (2 * i + 1 < want) pair(d.node, 2 * i); });
      this.outputs = { mixing, channels: want };
      return;
    }
    pair(this.masterMeter, 0);
    if (headphones === "34" && want >= 4) pair(this.phones, 2);
    else if (headphones && headphones !== "off" && headphones !== "34") {
      // a separate headphone device gets its own context, fed through a media stream
      const out = ctx.createMediaStreamDestination(); this.phones.connect(out);
      this.phonesCtx = new AudioContext({ latencyHint: "interactive" });
      try { await this.phonesCtx.setSinkId(headphones); } catch (e) { this.emit("error", `Couldn't use the headphone output: ${e.message}`); }
      this.phonesCtx.createMediaStreamSource(out.stream).connect(this.phonesCtx.destination);
    }
    this.outputs = { mixing, channels: want, headphones };
  }

  // ---- mixer
  set(k, v) {
    v = clamp(v, 0, 1); const t = this.ctx.currentTime, r = (p, x) => p.setTargetAtTime(x, t, 0.012);
    if (k === "xfader") {  // constant power; A and C on the left, B and D on the right
      this.mix.xfader = v; const L = Math.cos(v * Math.PI / 2), R = Math.sin(v * Math.PI / 2), norm = Math.SQRT2;
      this.channels.forEach((ch, i) => r(ch.xf.gain, Math.min(1, (i % 2 ? R : L) * norm)));
    } else if (k === "master") { this.mix.master = v; r(this.master.gain, (v / 0.8) ** 2); }
    else if (k === "phonesMix") { this.mix.phonesMix = v; r(this.phonesCue.gain, Math.cos(v * Math.PI / 2)); r(this.phonesMaster.gain, Math.sin(v * Math.PI / 2)); }
    else if (k === "phonesVol") { this.mix.phonesVol = v; r(this.phones.gain, (v / 0.8) ** 2); }
  }
  masterLevel() { this.masterMeter.getFloatTimeDomainData(this.masterBuf); let p = 0; for (const x of this.masterBuf) { const a = Math.abs(x); if (a > p) p = a; } return p; }

  // ---- loading
  async load(id, track, { force = false } = {}) {
    await this.start();
    const d = this.deck(id), ch = this.channel(id);
    if (!force && d.playing && ch.v.fader > 0.05 && this.audible(d)) throw new Error(`Deck ${id} is playing. Pause it first, or hold Shift to load anyway`);
    d.loading = true; d.pause(); this.emit("deck", d);
    try {
      const [buf, wave] = await Promise.all([
        fetch(`/api/audio/${track.id}`).then((r) => { if (!r.ok) throw new Error("The file is missing or can't be read"); return r.arrayBuffer(); }).then((b) => this.ctx.decodeAudioData(b)),
        fetch(`/api/wave/${track.id}`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      ]);
      const n = buf.length, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L, pcm = new Int16Array(n * 2);
      for (let i = 0; i < n; i++) { pcm[2 * i] = clamp(L[i], -1, 1) * 32767; pcm[2 * i + 1] = clamp(R[i], -1, 1) * 32767; }
      Object.assign(d, { t: track, grid: new Grid(track), wave, cues: (track.cues || []).map((c) => ({ ...c })), frames: n, loop: null, lastLoop: null, tempo: 0, nudge: 0, correction: 0, pos: 0 });
      const mem = d.cues.filter((c) => !c.slot).sort((a, b) => a.start_ms - b.start_ms);
      d.cueAt = mem.length ? mem[0].start_ms / 1000 : d.grid.ok ? Math.max(0, d.grid.time(Math.ceil(d.grid.index(0)))) : 0;
      d.post({ type: "load", pcm, at: d.cueAt * this.ctx.sampleRate }, [pcm.buffer]);
      d.pos = d.cueAt * this.ctx.sampleRate; d.loading = false;
      ch.setAuto(track.autoGainDb || 0);
      if (d.sync) { const L2 = this.leader(); if (L2 && L2 !== d) d.matchTempo(L2); else d.sync = false; }
      d.applyRate(true);
      if (this.leaderId === id && !d.sync) this.leaderId = null;
    } finally { d.loading = false; this.emit("deck", d); }
    return d;
  }
  audible(d) { const i = DECK_IDS.indexOf(d.id), x = this.mix.xfader; return i % 2 ? x > 0.02 : x < 0.98; }
  eject(id) { const d = this.deck(id); if (d.playing) return; d.post({ type: "unload" }); Object.assign(d, { t: null, grid: null, wave: null, cues: [], frames: 0, loop: null }); this.emit("deck", d); }

  async saveCues(d) {
    this.emit("deck", d);
    try { const r = await fetch("/api/cues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.t.id, cues: d.cues }) }).then((x) => x.json()); if (r.cues) d.cues = r.cues; }
    catch (e) { this.emit("error", e.message); }
    this.emit("deck", d);
  }

  // ---- sync: one leader; followers match its tempo and stay phase-locked
  leader() {
    const L = this.leaderId && this.deck(this.leaderId);
    if (L && L.loaded && L.grid.ok) return L;
    return this.decks.find((d) => d.loaded && d.playing && d.grid.ok) || null;
  }
  // a deck that starts playing leads, unless it's following a leader that's already going
  claimLeader(d) { const L = this.leader(); if (!L || L === d || !L.playing) this.leaderId = d.id; }
  makeLeader(d) { if (d.loaded) { this.leaderId = d.id; d.sync = false; d.correction = 0; d.applyRate(); this.emit("deck", d); } }
  phaseError(d, L) {  // follower's beat phase minus leader's, in beats, wrapped to [-0.5, 0.5)
    const a = L.grid.index(L.time(false)), b = d.grid.index(d.time(false));
    let e = (b - Math.floor(b)) - (a - Math.floor(a)); e -= Math.round(e); return e;
  }
  alignPhase(d) {
    const L = this.leader(); if (!L || L === d || !L.playing || !d.grid || !d.grid.ok) return;
    d.matchTempo(L); d.applyRate(true);
    const e = this.phaseError(d, L), s = d.time(false);
    d.seek(d.grid.time(d.grid.index(s) - e));
  }
  tick() {
    const L = this.leader();
    for (const d of this.decks) {
      if (!d.sync || !d.loaded || !L || L === d) { if (d.correction) { d.correction = 0; d.applyRate(); } continue; }
      const before = d.tempo; d.matchTempo(L);
      let corr = 0;
      if (d.playing && L.playing) corr = clamp(-this.phaseError(d, L) * 0.18, -0.02, 0.02);
      if (Math.abs(corr - d.correction) > 1e-4 || before !== d.tempo) { d.correction = corr; d.applyRate(); }
    }
    this.emit("tick");
  }
}
