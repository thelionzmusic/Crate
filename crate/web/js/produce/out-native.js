// Production's sound on Crate's native engine (studio.cpp): used whenever Perform runs on it,
// so tracks, effects and clips play over ASIO, WASAPI or Core Audio with the decks, not
// through the browser. Same shape as out-web.js; the page keeps the set and the timing and
// sends only what changed, and the engine sends meters back 30 times a second.
import { api } from "../core/api.js";
import { link } from "../engine/native.js";
import { DEVICES } from "./fx/devices.js";
import { valueOf } from "./fx/params.js";
import { curves } from "./fx/response.js";
import { gainOf, srcKey } from "./units.js";

const LETTERS = "ABCDEFGHIJKL";
const n5 = (v) => Number(v.toFixed(5));
const SILENT = [0, 0];

export class NativeOut {
  constructor(studio) {
    this.studio = studio; this.kind = "native";
    this.tracks = new Map(); this.returns = new Map();
    this.peaks = {}; this.meters = {}; this.outs = {}; this.voiceId = 0; this.bufId = 0;
  }

  async start(perf) {
    this.b = perf.backend;
    link.on("studio", (m) => { this.peaks = m.s; this.meters = m.d; this.outs = m.o || {}; });
    link.on("opened", () => this.reopened());
    this.main = this.handle("main", "m");
  }
  now() { return this.b.now(); }
  send(line) { link.send(`s ${line}`); }

  // the sound card was reopened: the engine starts empty, so everything is built again
  reopened() {
    this.tracks.clear(); this.returns.clear(); this.peaks = {}; this.meters = {}; this.fedTo = null;
    this.main = this.handle("main", "m");
    this.studio.forget();
  }

  // ---- strips, known to the engine by key: "t<id>", "r<letter>", "main"
  handle(key, kind, letter = "") {
    this.send(`strip ${key} ${kind}${letter === "" ? "" : ` ${letter}`}`);
    return { key, fx: new Map(), sends: new Map(), level: "", wired: "", into: "main", playing: null, queued: null, voices: [], meter: () => this.peaks[key] || 0 };
  }
  track(t) {
    let x = this.tracks.get(t.id);
    if (!x) { x = this.handle(`t${t.id}`, "t"); this.tracks.set(t.id, x); }
    return x;
  }
  ret(r) {
    let x = this.returns.get(r.id);
    if (!x) { x = this.handle(`r${r.id}`, "r", LETTERS.indexOf(r.id)); this.returns.set(r.id, x); }
    return x;
  }

  // `into`: the strip it plays out to, a group's or Main's (null for returns and Main itself)
  mix(x, o, audible, returns, into) {
    if (into && x.into !== into.key) { x.into = into.key; this.send(`route ${x.key} ${into.key}`); }
    const level = `${n5(audible ? gainOf(o.volume) : 0)} ${n5(o.pan || 0)}`;
    if (level !== x.level) { x.level = level; this.send(`level ${x.key} ${level}`); }
    if (o.kind) {
      for (const r of returns) {
        const g = n5(gainOf(o.sends?.[r.id] ?? 0));
        if (x.sends.get(r.id) !== g) { x.sends.set(r.id, g); this.send(`send ${x.key} ${LETTERS.indexOf(r.id)} ${g}`); }
      }
    }
    this.chain(x, o.devices || []);
  }
  keepReturns(returns) {
    for (const [id, x] of this.returns) {
      if (returns.some((r) => r.id === id)) continue;
      this.send(`drop ${x.key}`);
      for (const t of this.tracks.values()) t.sends.delete(id);
      this.returns.delete(id);
    }
  }

  dropTrack(id) { this.send(`drop ${this.tracks.get(id).key}`); this.tracks.delete(id); }

  // The chain goes as one line when its order or on/off changes; parameters go one by one,
  // only those that changed. Each device has a stand-in here for its display and meter.
  chain(x, devices) {
    const known = devices.filter((d) => DEVICES[d.type]);
    const sig = known.map((d) => `${d.id}:${d.type}:${d.on === false ? 0 : 1}`).join(",") || "-";
    if (sig !== x.wired) { x.wired = sig; this.send(`chain ${x.key} ${sig}`); }
    for (const id of x.fx.keys()) if (!known.some((d) => d.id === id)) x.fx.delete(id);
    for (const d of known) {
      let inst = x.fx.get(d.id);
      if (!inst) {
        const out = this, id = d.id;
        inst = { def: DEVICES[d.type], last: {}, get meter() { return out.meters[id] ?? 0; }, out: () => out.outs[id] || SILENT };
        x.fx.set(d.id, inst);
      }
      let moved = false;
      for (const p of inst.def.params) {
        const v = valueOf(p, d.params);
        if (inst.last[p.k] !== v) { inst.last[p.k] = v; this.send(`p ${d.id} ${p.k} ${+v}`); moved = true; }
      }
      if (moved) curves(inst, d.type, inst.last, this.b.sampleRate);
      if (inst.def.samples) this.feed(d);
    }
  }
  retempo(bpm) { this.send(`tempo ${bpm}`); }

  // a sampling instrument's sample: decoded to the engine's rate, then handed to the device
  feed(d) {
    const inst = this.fedTo ||= new Map(), key = d.sample ? srcKey(d.sample) : "";
    if (inst.get(d.id) === key) return;
    inst.set(d.id, key);
    if (!d.sample) return this.send(`sample ${d.id} -1`);
    this.studio.load(d.sample).then((buf) => { if (inst.get(d.id) === key) this.send(`sample ${d.id} ${buf.id}`); }).catch((e) => this.studio.emit("error", e.message));
  }

  // ---- clip audio: Crate decodes it to the engine's rate (cached on disk); the engine reads it
  async decode(src) {
    const rate = this.b.sampleRate, id = ++this.bufId;
    const { path, frames } = src.kind === "track" ? await api("pcm", { id: src.id, rate }) : await api("sample/pcm", { f: src.f, p: src.p, rate });
    await link.request(`s buf ${id} ${path}`, "sbuf", { what: "sbuf", match: (m) => m.id === id, ms: 60000 });
    return { id, duration: frames / rate };
  }
  // one pass of a clip; the engine starts it on its exact frame. Passes that have ended drop off.
  voice(x, buf, when, from, rate, len, voices) {
    const now = this.now();
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end < now) voices.splice(i, 1);
    const id = ++this.voiceId;
    this.send(`play ${id} ${x.key} ${buf.id} ${when} ${from} ${rate} ${len ?? -1}`);
    return { id, end: len == null ? Infinity : when + len / rate };
  }
  // a note for the track's instrument; the engine drops it if the track has none
  note(x, pitch, vel, when, dur, voices) {
    const now = this.now();
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end < now) voices.splice(i, 1);
    const id = ++this.voiceId;
    this.send(`note ${id} ${x.key} ${pitch} ${n5(vel)} ${when} ${n5(dur)}`);
    return { id, end: when + dur };
  }
  silence(voices, when) { for (const v of voices.splice(0)) this.send(`stop ${v.id} ${when}`); }

  preview(buf) { this.stopPreview(); this.send(`play ${++this.voiceId} preview ${buf.id} ${this.now()} 0 1 -1`); }
  stopPreview() { this.send("stopall preview"); }
}
