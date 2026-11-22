// Production's sound: a transport, clip launching, and each track's mixer. No DOM here.
//
// Tempo and beat come from the Perform tab: with Follow on and a deck playing, the transport
// runs on the lead deck's beat grid, so a clip launched here lands on the deck's bars, not
// merely at its BPM. With nothing playing it runs free at the set's own tempo.
//
// Clips are scheduled a little ahead on the audio clock (Web Audio sources), so timing never
// depends on the page being busy. A clip with a tempo is stretched to the transport by its
// playback rate, re-read every loop; one-shots play as they are.

import { PERFORM } from "./bridge.js";
import { applyDevice, createDevice, disposeDevice } from "./fx/devices.js";

const LOOKAHEAD = 0.18, TICK_MS = 25, BAR = 4;
export const UNITY = 0.85;  // the fader position for 0 dB
export const gainOf = (v) => (v / UNITY) ** 2;

export class Studio {
  constructor() {
    this.tracks = new Map(); this.returns = new Map(); this.loading = new Map(); this.decoded = new Map(); this.listeners = new Set();
    this.bpm = 124; this.follow = true; this.quantise = BAR;
    this.free = { t: 0, beat: 0 };  // when running free: the beat at audio time t
    this.arrangement = []; this.song = null;  // the timeline's clips, and while it plays: where bar 1 sits on the transport
  }

  // ---- start: share the Perform engine's context and output where possible
  async start() {
    if (this.ctx) return this;
    const perf = await PERFORM.engine();
    const web = perf.backend?.kind === "web";
    this.ctx = web ? perf.backend.ctx : new AudioContext({ latencyHint: "interactive" });
    try { await this.ctx.audioWorklet.addModule(new URL("./fx/dynamics.worklet.js", import.meta.url)); } catch (e) { this.emit("error", `Some effects couldn't load: ${e.message}`); }
    this.main = this.strip(web ? perf.backend.master : this.ctx.destination);  // with the decks: through their limiter
    this.mainMeter = this.main.meter;
    this.free = { t: this.ctx.currentTime, beat: 0 };
    setInterval(() => this.schedule(), TICK_MS);
    return this;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, x) { for (const fn of this.listeners) fn(kind, x); }

  // ---- the clock: beats now, and the audio time of any beat
  get leader() { const L = this.follow ? PERFORM.leader() : null; return L && L.playing && L.grid?.ok ? L : null; }
  tempo() { const L = this.leader; return L ? L.bpm : this.bpm; }
  beatNow() {
    const L = this.leader, now = this.ctx.currentTime;
    if (L) {
      const b = L.grid.index(L.time(false));
      this.free = { t: now, beat: b };  // if the deck stops, carry on from where it was
      return b;
    }
    return this.free.beat + (now - this.free.t) * this.bpm / 60;
  }
  timeOf(beat, now = this.ctx.currentTime, b0 = this.beatNow()) { return now + (beat - b0) * 60 / this.tempo(); }
  nextLaunch(b0 = this.beatNow()) { return this.quantise ? Math.ceil((b0 + 1e-6) / this.quantise) * this.quantise : b0; }
  setTempo(bpm) { const b = this.beatNow(); this.bpm = Math.min(999, Math.max(20, bpm)); this.free = { t: this.ctx.currentTime, beat: b }; this.emit("tempo"); }

  // ---- strips: every track, return and Main runs input → devices → volume → pan → out,
  // metered after the pan. A track's sends leave after its fader, into the returns' inputs.
  strip(out) {
    const input = this.ctx.createGain(), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
    input.connect(gain); gain.connect(pan); pan.connect(out);
    return { input, gain, pan, meter: meter(this.ctx, pan), fx: new Map(), links: [[input, gain]], wired: "", sends: new Map(), playing: null, queued: null, voices: [] };
  }
  track(t) {
    let x = this.tracks.get(t.id);
    if (!x) { x = this.strip(this.main.input); this.tracks.set(t.id, x); }
    return x;
  }
  ret(r) {
    let x = this.returns.get(r.id);
    if (!x) { x = this.strip(this.main.input); this.returns.set(r.id, x); }
    return x;
  }
  // the strip behind a track, a return or Main
  stripOf(o) { return o.kind ? this.track(o) : o.id ? this.ret(o) : this.main; }

  // levels, sends and devices for one strip; a soloed set mutes the tracks that aren't
  mix(o, { solo = false, returns = [] } = {}) {
    const x = this.stripOf(o), now = this.ctx.currentTime, audible = !o.mute && (!o.kind || !solo || o.solo);
    x.gain.gain.setTargetAtTime(audible ? gainOf(o.volume) : 0, now, 0.01);
    x.pan.pan.setTargetAtTime(o.pan || 0, now, 0.01);
    if (o.kind) {
      for (const r of returns) {
        let g = x.sends.get(r.id);
        if (!g) { g = this.ctx.createGain(); g.gain.value = 0; x.pan.connect(g); g.connect(this.ret(r).input); x.sends.set(r.id, g); }
        g.gain.setTargetAtTime(gainOf(o.sends?.[r.id] ?? 0), now, 0.01);
      }
    }
    this.chain(x, o.devices || []);
  }
  // returns that were deleted: their strips and every send into them go
  keepReturns(returns) {
    for (const [id, x] of this.returns) {
      if (returns.some((r) => r.id === id)) continue;
      for (const t of this.tracks.values()) { t.sends.get(id)?.disconnect(); t.sends.delete(id); }
      this.chain(x, []); x.pan.disconnect(); this.returns.delete(id);
    }
  }

  // Devices in order between the strip's input and its fader; one switched off is skipped.
  // Only a changed order or on/off state rewires; turning a knob just sets parameters.
  chain(x, devices) {
    const bpm = this.tempo();
    for (const [id, inst] of x.fx) if (!devices.some((d) => d.id === id)) { disposeDevice(inst); x.fx.delete(id); }
    for (const d of devices) {
      let inst = x.fx.get(d.id);
      if (!inst) {
        try { inst = createDevice(this.ctx, d.type); } catch (e) { this.emit("error", `${d.type} couldn't start: ${e.message}`); }
        if (!inst) continue;
        x.fx.set(d.id, inst);
      }
      applyDevice(inst, d, bpm);
    }
    const live = devices.filter((d) => d.on !== false && x.fx.has(d.id)), sig = live.map((d) => d.id).join();
    if (sig === x.wired) return;
    for (const [a, b] of x.links) { try { a.disconnect(b); } catch { /* went with its device */ } }
    const nodes = [x.input, ...live.flatMap((d) => { const i = x.fx.get(d.id); return [i.input, i.output]; }), x.gain];
    x.links = [];
    for (let i = 0; i < nodes.length; i += 2) { nodes[i].connect(nodes[i + 1]); x.links.push([nodes[i], nodes[i + 1]]); }
    x.wired = sig;
  }
  // the live instance of a device, for its display and meters
  device(o, id) { return this.ctx ? this.stripOf(o).fx.get(id) : null; }

  // synced delays and LFOs follow the tempo; checked each tick, applied only when it moved
  retempo(bpm) {
    if (bpm === this.lastBpm) return;
    this.lastBpm = bpm;
    for (const x of [this.main, ...this.tracks.values(), ...this.returns.values()]) {
      for (const inst of x.fx.values()) if (inst.def.tempo) { inst.set(inst.last, new Set(["bpm"]), bpm); inst.bpm = bpm; }
    }
  }

  // ---- audio for clips: decoded once, shared by every clip that uses it
  load(src) {
    const key = srcKey(src);
    if (!this.loading.has(key)) {
      this.loading.set(key, fetch(srcUrl(src)).then((r) => { if (!r.ok) throw new Error("That sound isn't there any more"); return r.arrayBuffer(); })
        .then((a) => this.ctx.decodeAudioData(a)).then((b) => { this.decoded.set(key, b); return b; })
        .catch((e) => { this.loading.delete(key); throw e; }));
    }
    return this.loading.get(key);
  }

  // ---- clip launching, on the next bar
  launch(t, clip) {
    const x = this.track(t), at = this.nextLaunch();
    x.queued = { clip, at }; this.emit("clips");
    this.load(clip.src).catch((e) => { x.queued = null; this.emit("error", e.message); });
  }
  stopTrack(t, now = false) {
    const x = this.track(t);
    if (now) { silence(x.voices, this.ctx.currentTime); x.playing = x.queued = null; } else x.queued = { clip: null, at: this.nextLaunch() };
    this.emit("clips");
  }
  stopAll(now = false) { for (const id of this.tracks.keys()) this.stopTrack({ id }, now); }
  state(t) { const x = this.tracks.get(t.id); return x ? { playing: x.playing?.clip, queued: x.queued, start: x.playing?.start } : {}; }
  get busy() { return !!this.song || [...this.tracks.values()].some((x) => x.playing || x.queued?.clip); }

  // ---- the timeline: plays from beat `from` of the arrangement, starting on the next bar
  playSong(from = 0) {
    this.stopSong();
    this.song = { at: this.nextLaunch(), from, live: [], started: new WeakSet() };
    for (const a of this.arrangement) this.load(a.clip.src).catch(() => {});
    this.emit("clips");
  }
  stopSong() { if (!this.song) return; silence(this.song.live.flatMap((v) => v.voices), this.ctx.currentTime); this.song = null; this.emit("clips"); }
  songBeat() { return this.song ? Math.max(this.song.from, this.beatNow() - this.song.at + this.song.from) : null; }

  // a preview from the browser: straight out, unstretched, one at a time
  async preview(src) {
    this.previewing?.stop();
    const s = this.ctx.createBufferSource(); s.buffer = await this.load(src); s.connect(this.main.gain); s.start();
    this.previewing = s;
  }
  stopPreview() { this.previewing?.stop(); this.previewing = null; }

  // ---- the scheduler: every 25 ms, put sound on the audio clock for the next 180 ms
  schedule() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime, b0 = this.beatNow(), bpm = this.tempo(), horizon = b0 + LOOKAHEAD * bpm / 60;
    const T = { now, b0, bpm, horizon };
    this.retempo(bpm);
    let changed = false;
    for (const x of this.tracks.values()) {
      if (x.queued && x.queued.at <= horizon) {  // a launch or stop is due
        silence(x.voices, this.timeOf(x.queued.at, now, b0));
        x.playing = x.queued.clip ? { clip: x.queued.clip, start: x.queued.at, next: x.queued.at, end: Infinity, into: 0, voices: x.voices } : null;
        x.queued = null; changed = true;
      }
      if (x.playing) this.run(x, x.playing, T);
    }
    if (this.song) this.runSong(T);
    if (changed) this.emit("clips");
  }

  // the arrangement's clips that start before the horizon join as players, each with an end
  runSong(T) {
    const g = this.song, off = g.at - g.from;  // transport beat = arrangement beat + off
    for (const a of this.arrangement) {
      const start = a.start + off, end = start + a.length;
      if (g.started.has(a) || end <= T.b0 || start > T.horizon) continue;
      g.started.add(a);
      const at = Math.max(start, T.b0, g.at);
      g.live.push({ clip: a.clip, next: at, end, into: at - start, voices: [], x: this.track({ id: a.track }) });
    }
    g.live = g.live.filter((p) => { this.run(p.x, p, T); return p.next < p.end; });
  }

  // each pass of a clip that starts before the horizon: looped clips repeat every `beats`,
  // stretched to the tempo; a pass that's already begun starts that far in
  run(x, p, T) {
    const buf = this.decoded.get(srcKey(p.clip.src));
    if (!buf) return;  // still decoding: it joins at the next pass
    const c = p.clip, rate = c.bpm ? T.bpm / c.bpm : 1;
    while (p.next <= T.horizon && p.next < p.end) {
      const pos = c.loop ? p.into % c.beats : p.into, beats = Math.min(c.loop ? c.beats - pos : Infinity, p.end - p.next);
      const when = this.timeOf(p.next, T.now, T.b0), late = Math.max(0, T.now - when);
      const from = (c.offset || 0) + (pos * 60 / T.bpm + late) * rate;
      if (from < buf.duration) {
        const s = this.ctx.createBufferSource();
        s.buffer = buf; s.playbackRate.value = rate; s.connect(x.input);
        const dur = (beats * 60 / T.bpm - late) * rate;
        if (Number.isFinite(dur)) s.start(Math.max(T.now, when), from, Math.max(0, dur)); else s.start(Math.max(T.now, when), from);
        p.voices.push(s); s.onended = () => { const i = p.voices.indexOf(s); if (i >= 0) p.voices.splice(i, 1); };
      }
      if (!c.loop) { p.next = p.end; break; }
      p.next += beats; p.into += beats;
    }
  }
}

// a stopped clip fades in 5 ms rather than clicking
function silence(voices, when) { for (const v of voices.splice(0)) { try { v.stop(when + 0.005); } catch { /* already stopped */ } } }

function meter(ctx, node) {
  const a = ctx.createAnalyser(); a.fftSize = 512; node.connect(a);
  const buf = new Float32Array(a.fftSize);
  return () => { a.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); return m; };
}

export const srcKey = (src) => (src.kind === "track" ? `t${src.id}` : `s${src.f}:${src.p}`);
export const srcUrl = (src) => (src.kind === "track" ? `/api/audio/${src.id}` : `/api/sample?f=${src.f}&p=${encodeURIComponent(src.p)}`);

export const studio = new Studio();
