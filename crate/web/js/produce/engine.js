// Production's timing: a transport, clip launching, the arrangement, and the strips' mix. No DOM.
//
// Tempo and beat come from the Perform tab: with Follow on and a deck playing, the transport
// runs on the lead deck's beat grid, so a clip launched here lands on the deck's bars, not
// merely at its BPM. With nothing playing it runs free at the set's own tempo.
//
// The sound comes from an output: out-native.js on Crate's native engine (ASIO, WASAPI, Core
// Audio) whenever Perform runs on it, otherwise out-web.js in the page. Clips are scheduled a
// little ahead on the output's clock, so timing never depends on the page being busy. A clip
// with a tempo is stretched to the transport by its playback rate, re-read every loop.

import { PERFORM } from "./bridge.js";
import { link } from "../engine/native.js";
import { NativeOut } from "./out-native.js";
import { WebOut } from "./out-web.js";
import { srcKey } from "./units.js";

export { UNITY, gainOf, srcKey, srcUrl } from "./units.js";

const LOOKAHEAD = 0.18, TICK_MS = 25, BAR = 4;

export class Studio {
  constructor() {
    this.loading = new Map(); this.decoded = new Map(); this.listeners = new Set();
    this.bpm = 124; this.follow = true; this.quantise = BAR;
    this.free = { t: 0, beat: 0 };  // when running free: the beat at output time t
    this.arrangement = []; this.song = null;  // the timeline's clips, and while it plays: where bar 1 sits on the transport
  }

  async start() {
    if (this.out) return this;
    const perf = await PERFORM.engine();
    const out = perf.backend?.kind === "native" && link.hello?.studio ? new NativeOut(this) : new WebOut(this);
    await out.start(perf);
    this.out = out;
    this.free = { t: this.now(), beat: 0 };
    setInterval(() => this.schedule(), TICK_MS);
    return this;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(kind, x) { for (const fn of this.listeners) fn(kind, x); }
  get native() { return this.out?.kind === "native"; }

  // the output dropped everything (the native engine reopened the sound card): decoded audio
  // and playing clips are gone, and the set is sent again by whoever listens for "reset"
  forget() { this.loading.clear(); this.decoded.clear(); this.song = null; this.lastBpm = null; this.emit("reset"); this.emit("clips"); }

  // ---- the clock: beats now, and the output time of any beat
  now() { return this.out.now(); }
  get leader() { const L = this.follow ? PERFORM.leader() : null; return L && L.playing && L.grid?.ok ? L : null; }
  tempo() { const L = this.leader; return L ? L.bpm : this.bpm; }
  beatNow() {
    const L = this.leader, now = this.now();
    if (L) {
      const b = L.grid.index(L.time(false));
      this.free = { t: now, beat: b };  // if the deck stops, carry on from where it was
      return b;
    }
    return this.free.beat + (now - this.free.t) * this.bpm / 60;
  }
  timeOf(beat, now = this.now(), b0 = this.beatNow()) { return now + (beat - b0) * 60 / this.tempo(); }
  nextLaunch(b0 = this.beatNow()) { return this.quantise ? Math.ceil((b0 + 1e-6) / this.quantise) * this.quantise : b0; }
  setTempo(bpm) { const b = this.beatNow(); this.bpm = Math.min(999, Math.max(20, bpm)); this.free = { t: this.now(), beat: b }; this.emit("tempo"); }

  // ---- strips: a track's, a return's or Main's, and their mix. `solo` is the set of tracks
  // that sound while anything's soloed (null when nothing is); returns and Main stay up. A
  // track in a group plays into the group's strip, everything else into Main.
  get tracks() { return this.out.tracks; }
  get returns() { return this.out.returns; }
  track(t) { return this.out.track(t); }
  ret(r) { return this.out.ret(r); }
  stripOf(o) { return o.kind ? this.track(o) : o.id ? this.ret(o) : this.out.main; }
  mainMeter() { return this.out.main.meter(); }
  mix(o, { solo = null, returns = [] } = {}) {
    const into = o.group ? this.track({ id: o.group }) : o.kind ? this.out.main : null;
    this.out.mix(this.stripOf(o), o, !o.mute && (!o.kind || !solo || solo.has(o.id)), returns, into);
  }
  keepReturns(returns) { this.out.keepReturns(returns); }
  // tracks that were deleted: their strips go, and nothing plays into them any more
  keepTracks(tracks) { const ids = new Set(tracks.map((t) => t.id)); for (const id of [...this.tracks.keys()]) if (!ids.has(id)) this.out.dropTrack(id); }
  // the live instance of a device, for its display and meters
  device(o, id) { return this.out ? this.stripOf(o).fx.get(id) : null; }
  // synced delays and LFOs follow the tempo; checked each tick, sent only when it moved
  retempo(bpm) { if (bpm !== this.lastBpm) { this.lastBpm = bpm; this.out.retempo(bpm); } }

  // ---- audio for clips: decoded once, shared by every clip that uses it
  load(src) {
    const key = srcKey(src);
    if (!this.loading.has(key)) {
      this.loading.set(key, this.out.decode(src).then((b) => { this.decoded.set(key, b); return b; })
        .catch((e) => { this.loading.delete(key); throw e; }));
    }
    return this.loading.get(key);
  }

  // ---- clip launching, on the next bar
  launch(t, clip) {
    const x = this.track(t), at = this.nextLaunch();
    x.queued = { clip, at }; this.emit("clips");
    if (clip.src) this.load(clip.src).catch((e) => { x.queued = null; this.emit("error", e.message); });
  }
  stopTrack(t, now = false) {
    const x = this.track(t);
    if (now) { this.out.silence(x.voices, this.now()); x.playing = x.queued = null; } else x.queued = { clip: null, at: this.nextLaunch() };
    this.emit("clips");
  }
  stopAll(now = false) { for (const id of this.tracks.keys()) this.stopTrack({ id }, now); }
  state(t) { const x = this.tracks.get(t.id); return x ? { playing: x.playing?.clip, queued: x.queued, start: x.playing?.start } : {}; }
  get busy() { return !!this.song || [...this.tracks.values()].some((x) => x.playing || x.queued?.clip); }

  // ---- the timeline: plays from beat `from` of the arrangement, starting on the next bar
  playSong(from = 0) {
    this.stopSong();
    this.song = { at: this.nextLaunch(), from, live: [], started: new WeakSet() };
    for (const a of this.arrangement) if (a.clip.src) this.load(a.clip.src).catch(() => {});
    this.emit("clips");
  }
  stopSong() { if (!this.song) return; this.out.silence(this.song.live.flatMap((v) => v.voices), this.now()); this.song = null; this.emit("clips"); }
  songBeat() { return this.song ? Math.max(this.song.from, this.beatNow() - this.song.at + this.song.from) : null; }

  // a note on a track's instrument now, as a key in the piano roll plays it
  audition(t, pitch, vel = 0.8, beats = 0.5) { if (this.out) this.out.note(this.track(t), pitch, vel, this.now() + 0.005, beats * 60 / this.tempo(), []); }

  // a preview from the browser: straight out, unstretched, one at a time
  async preview(src) { this.out.preview(await this.load(src)); }
  stopPreview() { this.out?.stopPreview(); }

  // ---- the scheduler: every 25 ms, put sound on the output's clock for the next 180 ms
  schedule() {
    if (!this.out) return;
    const now = this.now(), b0 = this.beatNow(), bpm = this.tempo(), horizon = b0 + LOOKAHEAD * bpm / 60;
    const T = { now, b0, bpm, horizon };
    this.retempo(bpm);
    let changed = false;
    for (const x of this.tracks.values()) {
      if (x.queued && x.queued.at <= horizon) {  // a launch or stop is due
        this.out.silence(x.voices, this.timeOf(x.queued.at, now, b0));
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
    if (p.clip.notes) return this.runNotes(x, p, T);
    const buf = this.decoded.get(srcKey(p.clip.src));
    if (!buf) return;  // still decoding: it joins at the next pass
    const c = p.clip, rate = c.bpm ? T.bpm / c.bpm : 1;
    while (p.next <= T.horizon && p.next < p.end) {
      const pos = c.loop ? p.into % c.beats : p.into, beats = Math.min(c.loop ? c.beats - pos : Infinity, p.end - p.next);
      const when = this.timeOf(p.next, T.now, T.b0), late = Math.max(0, T.now - when);
      const from = (c.offset || 0) + (pos * 60 / T.bpm + late) * rate;
      if (from < buf.duration) {
        const dur = (beats * 60 / T.bpm - late) * rate;
        p.voices.push(this.out.voice(x, buf, Math.max(T.now, when), from, rate, Number.isFinite(dur) ? Math.max(0, dur) : null, p.voices));
      }
      if (!c.loop) { p.next = p.end; break; }
      p.next += beats; p.into += beats;
    }
  }

  // A MIDI clip schedules only the notes that start before the horizon, so an edit is heard
  // within a tick. Looped, it wraps at its length; otherwise it ends there. A note that runs past
  // the loop's end is cut there, as Ableton does; velocity is MIDI's 1–127.
  runNotes(x, p, T) {
    const c = p.clip, len = c.beats, to = Math.min(T.horizon, p.end);
    while (p.next < to) {
      if (!c.loop && p.into >= len) { p.next = p.end; return; }
      const pos = c.loop ? p.into % len : p.into, span = Math.min(len - pos, to - p.next);
      for (const n of c.notes) {
        if (n.s < pos || n.s >= pos + span) continue;
        const at = p.next + n.s - pos, when = this.timeOf(at, T.now, T.b0);
        if (when < T.now - 0.003) continue;  // its moment passed while the page was busy
        const beats = Math.min(n.l, len - n.s, p.end - at);
        const v = this.out.note(x, n.p, n.v / 127, Math.max(T.now, when), beats * 60 / T.bpm, p.voices);
        if (v) p.voices.push(v);
      }
      p.next += span; p.into += span;
    }
  }
}

export const studio = new Studio();
