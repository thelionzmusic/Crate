// Crate's DJ engine: decks, mixer, sync and outputs. No DOM here; the Performance view and
// hardware mappings drive it through the same methods.
//
// Signal per channel:
//   deck -> trim -> 3-band isolator (LR4 crossovers at 220 Hz / 2.6 kHz) -> filter
//        -> FX unit 1 -> FX unit 2 -> [pre-fader: meter, headphone cue] -> channel fader -> crossfader -> master
// The master runs through a fast limiter at -1 dBFS so nothing ever clips. "External mixer"
// mode skips all of that and sends each deck to its own output pair, for a DJM.
//
// The sound itself comes from a backend: web.js (Web Audio, in the page) or native.js (Crate's
// C++ engine on ASIO/WASAPI). This file is the musical logic both share.

import { EFFECTS } from "./fx.js";
import { WebBackend } from "./web.js";
import { NativeBackend } from "./native.js";

const POS = 0, RATE = 1, PLAYING = 2, TIME = 3, TARGET = 4;  // deck state slots, same layout in both backends
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const DECK_IDS = ["A", "B", "C", "D"];
export const LOOP_SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
export const RANGES = [0.06, 0.1, 0.16, 0.5];

// ---------- beat grid: constant tempo, or the per-beat list for tracks that drift
// A track's beat grid: first beat + bpm for steady tracks, or every beat listed for tracks
// that change tempo or drift. `tempos` marks where each tempo section starts.
export class Grid {
  constructor(t) {
    this.bpm = t.bpm || 0; this.t0 = (t.first_beat_ms || 0) / 1000; this.db = t.downbeat || 0;
    this.b = t.beats && t.beats.length > 1 ? Float64Array.from(t.beats, (ms) => ms / 1000) : null;
    this.tempos = t.tempos && t.tempos.length > 1 ? t.tempos.map((x) => ({ s: x.ms / 1000, bpm: x.bpm })) : null;
  }
  // the track's own tempo at time s: exact per section, averaged over a bar while drifting
  bpmAt(s) {
    if (this.tempos) { let k = 0; while (k + 1 < this.tempos.length && this.tempos[k + 1].s <= s) k++; return this.tempos[k].bpm; }
    const b = this.b; if (!b) return this.bpm;
    const i = clamp(Math.floor(this.index(s)), 2, b.length - 3);
    return 240 / (b[i + 2] - b[i - 2]);
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
    const k = clamp(Math.floor(i), 0, b.length - 2);
    return b[k] + (i - k) * (b[k + 1] - b[k]);
  }
  isDownbeat(i) { return ((Math.round(i) - this.db) % 4 + 4) % 4 === 0; }
}

// ---------- one deck, as the main thread sees it
class Deck {
  constructor(engine, id, i) {
    this.e = engine; this.id = id; this.t = null; this.grid = null; this.wave = null; this.cues = []; this.version = 0;
    this.frames = 0; this.rate = 1; this._playing = false; this.loading = false;
    this.tempo = 0; this.range = 0.1; this.keylock = true; this.sync = false; this.nudge = 0; this.correction = 0;
    this.cueAt = 0; this.previewing = false; this.loop = null; this.loopBeats = 4; this.lastLoop = null;
    // position and rate written by the audio side; shared memory with the web backend, frames from the native one
    this.port = engine.backend.deckPort(i, () => { this._playing = false; this.changed(); });
    this.sh = this.port.sh; this.shared = this.port.shared;
    this.post({ type: "keylock", on: this.keylock });
  }
  post(m) { this.port.post(m); }
  changed() { this.version++; this.e.emit("deck", this); }
  get loaded() { return !!this.t && !this.loading; }
  get playing() { return this._playing; }
  get sr() { return this.e.backend.sampleRate; }
  get duration() { return this.frames / this.sr; }
  // position in seconds, extrapolated from the audio thread's last block; audible=true
  // shifts it back by the output latency so the playhead matches what you hear
  time(audible = true) {
    const sh = this.sh;
    let f = sh[POS];
    if (sh[PLAYING]) f += Math.max(0, this.e.backend.now() - sh[TIME]) * this.sr * sh[RATE];
    let s = f / this.sr;
    if (audible && sh[PLAYING]) s -= this.e.latency * this.rate;
    return clamp(s, 0, this.duration);
  }
  get baseRate() { return 1 + this.tempo * this.range; }
  get bpm() { return this.grid && this.grid.ok ? this.grid.bpmAt(this.time(false)) * this.baseRate : 0; }  // live: follows tempo changes
  applyRate(now = false) {
    this.rate = Math.max(0.05, this.baseRate * (1 + this.nudge) * (1 + this.correction));
    this.sh[TARGET] = this.rate;
    if (!this.shared || now) this.post({ type: "rate", rate: this.rate, now });
  }
  setTempo(v) { this.tempo = clamp(v, -1, 1); if (this.sync && this.e.leader() !== this) this.sync = false; this.applyRate(); this.changed(); }
  seek(s) { const f = clamp(s, 0, this.duration) * this.sr; this.sh[POS] = f; this.post({ type: "seek", frame: f }); }
  // jump while keeping the beat phase, so quantised cues and jumps land in time
  seekQuantised(s) {
    if (!this.e.quantise || !this.grid || !this.grid.ok || !this.playing) return this.seek(s);
    const g = this.grid, i = g.index(this.time(false));
    return this.seek(g.time(Math.round(g.index(s)) + (i - Math.floor(i))));
  }
  snap(s) { return this.e.quantise && this.grid && this.grid.ok ? this.grid.time(Math.round(this.grid.index(s))) : s; }

  play() {
    if (!this.loaded) return;
    this.previewing = false;
    if (this.sync) this.e.alignPhase(this);
    this.post({ type: "play" }); this._playing = true;
    this.e.claimLeader(this); this.changed();
  }
  pause() { this.post({ type: "pause" }); this._playing = false; this.changed(); }
  togglePlay() { this.playing ? this.pause() : this.play(); }

  // CDJ cue: playing -> back to cue and stop. Paused -> set cue here, and preview while held.
  cueDown() {
    if (!this.loaded) return;
    if (this.playing && !this.previewing) { this.pause(); this.seek(this.cueAt); return; }
    const here = this.time(false);
    if (Math.abs(here - this.cueAt) > 0.002) { this.cueAt = this.snap(here); this.seek(this.cueAt); }
    this.previewing = true; this.post({ type: "play" }); this._playing = true; this.changed();
  }
  cueUp() { if (this.previewing) { this.previewing = false; this.pause(); this.seek(this.cueAt); } }

  hotCue(slot, del = false) {
    if (!this.loaded) return;
    const c = this.cues.find((x) => x.slot === slot);
    if (del) { if (c) { this.cues = this.cues.filter((x) => x !== c); this.e.saveCues(this); } return; }
    if (!c) { this.cues.push({ slot, start_ms: Math.round(this.snap(this.time(false)) * 1000), end_ms: -1, color: null, name: "" }); this.e.saveCues(this); return; }
    const s = c.start_ms / 1000;
    if (c.end_ms > c.start_ms) {  // a loop pad starts its loop
      this.lastLoop = this.loop; this.loop = [s, c.end_ms / 1000];
      this.loopBeats = this.grid && this.grid.ok ? Math.max(1 / 32, Math.round(this.grid.index(this.loop[1]) - this.grid.index(s))) : 4;
      this.sendLoop();
    }
    if (this.playing) this.seekQuantised(s); else { this.seek(s); this.play(); }
  }

  // ---- loops, in beats
  sendLoop() { this.post({ type: "loop", loop: this.loop ? [this.loop[0] * this.sr, this.loop[1] * this.sr] : null }); this.changed(); }
  loopToggle(beats = this.loopBeats) {
    if (!this.loaded || !this.grid || !this.grid.ok) return;
    if (this.loop) { this.lastLoop = this.loop; this.loop = null; this.sendLoop(); return; }
    const g = this.grid, now = g.index(this.time(false)), i = this.e.quantise ? Math.floor(now + 1e-6) : now;
    this.loopBeats = beats; this.loop = [g.time(i), g.time(i + beats)]; this.sendLoop();
  }
  loopResize(factor) {
    const k = LOOP_SIZES.indexOf(this.loopBeats) + (factor > 1 ? 1 : -1);
    if (k < 0 || k >= LOOP_SIZES.length) return;
    this.loopBeats = LOOP_SIZES[k];
    if (this.loop) { const g = this.grid; this.loop = [this.loop[0], g.time(g.index(this.loop[0]) + this.loopBeats)]; this.sendLoop(); }
    else this.changed();
  }
  reloop() { if (!this.lastLoop) return; this.loop = this.lastLoop; this.sendLoop(); this.seekQuantised(this.loop[0]); if (!this.playing) this.play(); }
  beatJump(beats) {
    if (!this.loaded || !this.grid || !this.grid.ok) return;
    const g = this.grid, now = this.time(false), target = g.time(g.index(now) + beats);
    if (this.loop) { const d = target - now; this.loop = [this.loop[0] + d, this.loop[1] + d]; this.sendLoop(); }
    this.seek(target);
  }
  setKeylock(on) { this.keylock = on; this.post({ type: "keylock", on }); this.changed(); }
  setSync(on) {
    this.sync = on && !!this.grid && this.grid.ok;
    if (this.sync) { const L = this.e.leader(); if (L && L !== this) { this.matchTempo(L); if (this.playing) this.e.alignPhase(this); } else this.e.leaderId = this.id; }
    else this.correction = 0;
    this.applyRate(); this.changed();
  }
  // follow the leader's tempo, picking half or double time when that's closer
  matchTempo(L) {
    if (!this.grid || !this.grid.ok || !L.bpm) return;
    const r0 = L.bpm / this.grid.bpmAt(this.time(false)), r = [r0, r0 * 2, r0 / 2].reduce((a, b) => (Math.abs(b - 1) < Math.abs(a - 1) ? b : a));
    if (Math.abs(r - 1) > this.range) this.range = RANGES.find((x) => Math.abs(r - 1) <= x) || RANGES.at(-1);
    this.tempo = clamp((r - 1) / this.range, -1, 1);
  }
}

// ---------- mixer channel: knob positions, turned into gains and frequencies for the backend
class Channel {
  constructor(engine, i) {
    this.e = engine; this.i = i;
    this.v = { trim: 0.5, high: 0.5, mid: 0.5, low: 0.5, filter: 0.5, fader: 1, cue: 0 }; this.auto = 0;
    this.meter = { peak: () => engine.backend.peak(i) };
  }
  set(k, v) {
    v = clamp(v, 0, 1); this.v[k] = v;
    const p = (name, x) => this.e.backend.setParam(this.i, name, x);
    if (k === "trim") p("trim", 10 ** ((this.auto + (v - 0.5) * 24) / 20));
    else if (k === "low" || k === "mid" || k === "high") p(k, v <= 0.5 ? (v / 0.5) ** 2 : 1 + (v - 0.5) * 2);   // kill .. +6 dB
    else if (k === "filter") {  // left: low-pass sweep, right: high-pass sweep, centre: open
      const d = v - 0.5;
      p("lpf", d < -0.02 ? 80 * (22000 / 80) ** ((d + 0.5) / 0.48) : 22000);
      p("hpf", d > 0.02 ? 10 * (9000 / 10) ** ((d - 0.02) / 0.48) : 10);
    } else if (k === "fader") p("fader", v * v);
    else if (k === "cue") p("cue", v);
  }
  setAuto(db) { this.auto = db; this.set("trim", this.v.trim); }
  resend() { for (const [k, v] of Object.entries(this.v)) this.set(k, v); }
}

// ---------- the engine
export class Engine {
  constructor() { this.listeners = new Set(); this.decks = []; this.channels = []; this.quantise = true; this.leaderId = null; this.ready = null; }

  // opts.engine: "native" for Crate's ASIO/WASAPI engine, otherwise the browser's
  start(opts = {}) {
    this.ready ||= (async () => {
      this.backend = await this.makeBackend(opts);
      DECK_IDS.forEach((id, i) => { this.decks.push(new Deck(this, id, i)); this.channels.push(new Channel(this, i)); });
      this.fx = [
        { type: "echo", on: false, mix: 0.5, p1: 0.5, p2: 0.6, beats: EFFECTS.echo.beats, decks: new Set(["A"]) },
        { type: "reverb", on: false, mix: 0.45, p1: 0.5, p2: 0.6, beats: EFFECTS.reverb.beats, decks: new Set(["B"]) },
      ];
      this.fxVersion = 0;
      this.mix = { xfader: 0.5, master: 0.8, phonesMix: 0.3, phonesVol: 0.8 };
      this.resendMixer();
      this.timer = setInterval(() => this.tick(), 40);
      return this;
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  async makeBackend(opts) {
    const err = (m) => this.emit("error", m);
    if (opts.engine === "native") {
      const b = new NativeBackend();
      b.onReset = (oldRate) => this.resync(oldRate);
      try { await b.start(opts, err); return b; } catch (e) { err(`Native audio didn't start, so Crate is using the browser's: ${e.message}`); }
    }
    const b = new WebBackend();
    await b.start(opts);
    await b.route(opts, err);
    return b;
  }

  // everything the backend holds, sent again (after the native engine reopens the sound card)
  resendMixer() {
    for (const ch of this.channels) ch.resend();
    for (const [k, v] of Object.entries(this.mix)) this.set(k, v);
    this.fxVersion++; for (const ch of this.channels) ch.fxKey = ""; this.applyFx();
  }
  async resync(oldRate) {
    this.resendMixer();
    for (const d of this.decks) {
      d.post({ type: "keylock", on: d.keylock });
      if (!d.t) continue;
      const at = d.sh[POS] / oldRate, was = d._playing;  // seconds, from the old device's frames
      d.loading = true; d.changed();
      try {
        d.frames = await this.backend.loadTrack(DECK_IDS.indexOf(d.id), d.t, at, d.port);
        d.applyRate(true); d.sendLoop();
        if (was) d.post({ type: "play" });
      } catch (e) { this.emit("error", e.message); } finally { d.loading = false; d.changed(); }
    }
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, x) { for (const fn of this.listeners) fn(kind, x); }
  get latency() { return this.backend ? this.backend.latency : 0; }
  deck(id) { return this.decks[DECK_IDS.indexOf(id)]; }
  channel(id) { return this.channels[DECK_IDS.indexOf(id)]; }

  // ---- outputs: the backend picks the device and channel pairs from Perform's settings
  async route(opts = {}) { await this.backend.route(opts, (m) => this.emit("error", m)); }

  // ---- mixer
  set(k, v) {
    v = clamp(v, 0, 1); const b = this.backend;
    if (k === "xfader") {  // constant power; A and C on the left, B and D on the right
      this.mix.xfader = v; const L = Math.cos(v * Math.PI / 2) * Math.SQRT2, R = Math.sin(v * Math.PI / 2) * Math.SQRT2;
      this.channels.forEach((ch, i) => b.setParam(i, "xf", Math.min(1, i % 2 ? R : L)));
    } else if (k === "master") { this.mix.master = v; b.setMix("master", (v / 0.8) ** 2); }
    else if (k === "phonesMix") { this.mix.phonesMix = v; b.setMix("phonesCue", Math.cos(v * Math.PI / 2)); b.setMix("phonesMaster", Math.sin(v * Math.PI / 2)); }
    else if (k === "phonesVol") { this.mix.phonesVol = v; b.setMix("phones", (v / 0.8) ** 2); }
  }
  masterLevel() { return this.backend.masterPeak(); }

  // ---- effects: two units, each assignable to any decks
  setFx(i, changes) {
    const u = this.fx[i];
    if (changes.type && changes.type !== u.type) { u.beats = EFFECTS[changes.type].beats; u.p1 = 0.5; u.p2 = 0.6; }
    Object.assign(u, changes);
    this.fxVersion++; this.applyFx();
  }
  assignFx(i, deckId, on) { const d = this.fx[i].decks; on ? d.add(deckId) : d.delete(deckId); this.fxVersion++; this.applyFx(); }
  // push unit settings and each deck's tempo into its channel's slots, only when something changed
  applyFx() {
    this.channels.forEach((ch, k) => {
      const d = this.decks[k], bpm = (d.loaded && d.grid.ok ? d.grid.bpmAt(d.time(false)) * d.rate : this.leader()?.bpm) || 120;
      const key = `${this.fxVersion}|${bpm.toFixed(2)}`;
      if (key === ch.fxKey) return;
      ch.fxKey = key;
      this.fx.forEach((u, i) => this.backend.applyFx(k, i, u, u.decks.has(d.id), bpm));
    });
  }

  // ---- loading
  async load(id, track, { force = false } = {}) {
    await this.start();
    const d = this.deck(id), ch = this.channel(id);
    if (!force && d.playing && ch.v.fader > 0.05 && this.audible(d)) throw new Error(`Deck ${id} is playing. Pause it first, or hold Shift to load anyway`);
    d.loading = true; if (d.playing) d.pause(); d.changed();
    try {
      const grid = new Grid(track), cues = (track.cues || []).map((c) => ({ ...c }));
      const mem = cues.filter((c) => !c.slot).sort((a, b) => a.start_ms - b.start_ms);
      const cueAt = mem.length ? mem[0].start_ms / 1000 : grid.ok ? Math.max(0, grid.time(Math.ceil(grid.index(0)))) : 0;
      const [frames, wave] = await Promise.all([
        this.backend.loadTrack(DECK_IDS.indexOf(id), track, cueAt, d.port),
        fetch(`/api/wave/${track.id}`).then((r) => r.arrayBuffer()).then((b) => new Uint8Array(b)),
      ]);
      Object.assign(d, { t: track, grid, wave, cues, frames, cueAt, loop: null, lastLoop: null, tempo: 0, nudge: 0, correction: 0 });
      ch.setAuto(track.autoGainDb || 0);
      if (d.sync) { const L = this.leader(); if (L && L !== d) d.matchTempo(L); else d.sync = false; }
      d.applyRate(true);
      if (this.leaderId === id && !d.sync) this.leaderId = null;
    } finally { d.loading = false; d.changed(); }
    return d;
  }
  audible(d) { const i = DECK_IDS.indexOf(d.id), x = this.mix.xfader; return i % 2 ? x > 0.02 : x < 0.98; }

  async saveCues(d) {
    d.changed();
    try {
      const r = await fetch("/api/cues", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: d.t.id, cues: d.cues }) }).then((x) => x.json());
      if (r.cues) d.cues = r.cues;
    } catch (e) { this.emit("error", e.message); }
    d.changed();
  }

  // ---- sync: one leader; followers match its tempo and stay phase-locked
  leader() {
    const L = this.leaderId && this.deck(this.leaderId);
    if (L && L.loaded && L.grid.ok) return L;
    return this.decks.find((d) => d.loaded && d.playing && d.grid.ok) || null;
  }
  // a deck that starts playing leads, unless it's following a leader that's already going
  claimLeader(d) { const L = this.leader(); if (!L || L === d || !L.playing) this.leaderId = d.id; }
  makeLeader(d) { if (!d.loaded) return; this.leaderId = d.id; d.sync = false; d.correction = 0; d.applyRate(); d.changed(); }
  phaseError(d, L) {  // follower's beat phase minus leader's, in beats, wrapped to [-0.5, 0.5)
    const a = L.grid.index(L.time(false)), b = d.grid.index(d.time(false));
    let e = (b - Math.floor(b)) - (a - Math.floor(a)); e -= Math.round(e); return e;
  }
  alignPhase(d) {
    const L = this.leader(); if (!L || L === d || !L.playing || !d.grid || !d.grid.ok) return;
    d.matchTempo(L); d.applyRate(true);
    d.seek(d.grid.time(d.grid.index(d.time(false)) - this.phaseError(d, L)));
  }
  // 25 times a second: followers track the leader's tempo, and a gentle correction pulls
  // their phase back in line. Rate changes go through shared memory, so this sends nothing.
  tick() {
    this.applyFx();  // timed effects follow tempo changes
    const L = this.leader();
    for (const d of this.decks) {
      if (!d.sync || !d.loaded || !L || L === d) { if (d.correction) { d.correction = 0; d.applyRate(); } continue; }
      const before = d.tempo; d.matchTempo(L);
      const corr = d.playing && L.playing ? clamp(-this.phaseError(d, L) * 0.18, -0.02, 0.02) : 0;
      if (Math.abs(corr - d.correction) > 1e-4 || before !== d.tempo) { d.correction = corr; d.applyRate(); }
    }
  }
}
