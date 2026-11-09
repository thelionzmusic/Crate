// The native audio backend: Crate's C++ engine (crate-engine) on ASIO or WASAPI.
//
// The page keeps all the DJ logic (engine.js); the engine renders the audio. They talk over a
// local WebSocket: one-line text commands out, and 100 times a second a binary state frame back
// with every deck's position and the meters. Positions between frames are extrapolated from the
// engine's own clock, so playheads stay smooth.

import { api } from "../core/api.js";

const POS = 0, RATE = 1, PLAYING = 2, TIME = 3, TARGET = 4;  // same slots as the web decks
export const API_NAMES = { asio: "ASIO", wasapi: "WASAPI", null: "No output (test)", alsa: "ALSA", pulse: "PulseAudio", core: "Core Audio" };

// ---------- the connection, shared by the backend and the Settings sheet
class Link {
  constructor() { this.ws = null; this.ready = null; this.waiting = new Set(); this.onFrame = null; this.onError = null; this.hello = null; }

  connect() {
    this.ready ||= (async () => {
      const info = await api("engine");
      if (!info.available) throw new Error("The native audio engine isn't part of this copy of Crate. Reinstall Crate to get it");
      const { port } = await api("engine/start", {});
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.binaryType = "arraybuffer";
      await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("Couldn't reach the native audio engine")); });
      ws.onmessage = (ev) => (typeof ev.data === "string" ? this.text(JSON.parse(ev.data)) : this.onFrame?.(new Float64Array(ev.data)));
      ws.onclose = () => { this.ws = null; this.ready = null; for (const w of this.waiting) w.fail(new Error("The native audio engine stopped")); this.onError?.("The native audio engine stopped. Open Perform again to restart it"); };
      this.ws = ws;
      this.hello = await this.request("hello", "hello");
      return this;
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }

  send(line) { if (this.ws && this.ws.readyState === 1) this.ws.send(line); }

  // send and wait for the reply of `type` (or an error about `what`)
  request(line, type, { what = line.split(" ")[0], match = () => true, ms = 20000 } = {}) {
    return new Promise((ok, fail) => {
      const w = { type, what, match, ok, fail };
      const timer = setTimeout(() => { this.waiting.delete(w); fail(new Error("The native audio engine didn't answer")); }, ms);
      w.ok = (m) => { clearTimeout(timer); ok(m); }; w.fail = (e) => { clearTimeout(timer); fail(e); };
      this.waiting.add(w); this.send(line);
    });
  }

  text(m) {
    for (const w of this.waiting) {
      if (m.type === w.type && w.match(m)) { this.waiting.delete(w); w.ok(m); return; }
      if (m.type === "error" && m.what === w.what) { this.waiting.delete(w); w.fail(new Error(m.message)); return; }
    }
    if (m.type === "error") this.onError?.(m.message);
  }

  async devices(apiName) { await this.connect(); return (await this.request(`devices ${apiName}`, "devices", { match: (m) => m.api === apiName })).list; }
  async apis() { await this.connect(); const a = this.hello.apis; const real = a.filter((x) => x !== "null"); return real.length ? real : a; }
}
export const link = new Link();

// ---------- the backend
export class NativeBackend {
  constructor() {
    this.kind = "native"; this.ports = []; this.peaks = new Float64Array(4); this.master = 0; this.ended = [0, 0, 0, 0];
    this.opened = null; this.openKey = ""; this.seq = 0; this.off = null; this.load = 0; this.xruns = 0;
    this.onReset = null;  // engine.js: the device was reopened, so decks and settings must be sent again
  }

  async start(opts = {}, onError = () => {}) {
    link.onError = onError;
    await link.connect();
    link.onFrame = (f) => this.frame(f);
    await this.route(opts, onError);
  }
  async resume() {}

  // engine clock, mapped onto the page's clock; frames only ever arrive late, so track the earliest
  now() { return this.off == null ? 0 : performance.now() / 1000 - this.off; }
  get latency() { return this.opened ? this.opened.latency : 0; }
  get sampleRate() { return this.opened ? this.opened.rate : 48000; }
  status() { return { latency: this.latency, load: this.load, xruns: this.xruns, buffer: this.opened?.buffer, rate: this.opened?.rate, name: this.opened?.name }; }

  frame(f) {
    const off = performance.now() / 1000 - f[0];
    if (this.off == null || off < this.off || off - this.off > 0.25) this.off = off; else this.off += (off - this.off) * 0.01;
    this.load = f[2]; this.xruns = f[3];
    for (let i = 0; i < 4; i++) {
      const p = this.ports[i], b = 5 + i * 5;
      if (p && !p.loading) { p.sh[POS] = f[b]; p.sh[RATE] = f[b + 1]; p.sh[PLAYING] = f[b + 2]; p.sh[TIME] = f[0]; }
      this.peaks[i] = f[b + 4];
      if (f[26 + i] > this.ended[i]) { this.ended[i] = f[26 + i]; p?.onEnded(); }  // counts per opened device
    }
    this.master = f[25];
  }

  deckPort(i, onEnded) {
    const sh = new Float64Array(8); sh[TARGET] = 1;
    const port = { sh, shared: false, onEnded, loading: false, post: (m) => this.post(i, m) };
    this.ports[i] = port;
    return port;
  }

  post(i, m) {
    switch (m.type) {
      case "play": case "pause": link.send(`${m.type} ${i}`); break;
      case "seek": link.send(`seek ${i} ${m.frame}`); this.ports[i].sh[POS] = m.frame; break;
      case "rate": link.send(`rate ${i} ${m.rate} ${m.now ? 1 : 0}`); break;
      case "keylock": link.send(`keylock ${i} ${m.on ? 1 : 0}`); break;
      case "loop": link.send(m.loop ? `loop ${i} ${m.loop[0]} ${m.loop[1]}` : `loop ${i} -`); break;
    }
  }

  // Crate decodes the file (cached on disk at this rate); the engine reads it on a loader thread
  async loadTrack(i, track, atSeconds, port) {
    const rate = this.sampleRate, at = atSeconds * rate, seq = ++this.seq;
    const { path, frames } = await api("pcm", { id: track.id, rate });
    port.loading = true;
    try {
      await link.request(`load ${i} ${at} ${seq} ${path}`, "loaded", { what: "load", match: (m) => m.seq === seq });
    } finally { port.loading = false; }
    port.sh[POS] = at; port.sh[PLAYING] = 0; port.sh[TIME] = this.now();
    return frames;
  }

  setParam(i, k, v) { link.send(`p ${i} ${k} ${v}`); }
  setMix(k, v) { link.send(`m ${k} ${v}`); }
  applyFx(i, slot, u, active, bpm) { link.send(`fx ${i} ${slot} ${u.type} ${u.on && active ? 1 : 0} ${u.mix} ${u.p1} ${u.p2} ${u.beats ?? 1} ${bpm}`); }
  peak(i) { return this.peaks[i]; }
  masterPeak() { return this.master; }

  // opens (or reopens) the sound card when the driver, device, rate, buffer or channel count changes
  async route(opts = {}, onError = () => {}) {
    const apis = await link.apis();
    const apiName = apis.includes(opts.api) ? opts.api : apis[0];
    const external = opts.mixing === "external";
    const masterAt = external ? 0 : +opts.masterOut || 0;
    const phonesAt = external || opts.phonesOut == null || +opts.phonesOut < 0 ? -1 : +opts.phonesOut;
    const channels = external ? 8 : Math.max(masterAt + 2, phonesAt + 2, 2);
    const key = JSON.stringify([apiName, opts.nativeDevice || "", +opts.rate || 0, +opts.buffer || 256, channels]);
    if (key !== this.openKey) {
      const list = await link.devices(apiName);
      const dev = list.find((d) => d.name === opts.nativeDevice) || list.find((d) => d.default) || list[0];
      if (!dev) throw new Error(`No ${API_NAMES[apiName] || apiName} outputs found. Is your soundcard connected?`);
      const was = this.opened;
      this.opened = await link.request(`open ${apiName} ${dev.id} ${+opts.rate || 0} ${+opts.buffer || 256} ${Math.min(channels, dev.outputs)}`, "opened", { ms: 30000 });
      this.openKey = key; this.off = null; this.ended = [0, 0, 0, 0];
      if (was) await this.onReset?.(was.rate);
    }
    if (phonesAt + 2 > this.opened.channels && phonesAt >= 0) onError(`${this.opened.name} has only ${this.opened.channels} outputs, so there's no headphone pair there`);
    link.send(`route ${external ? 1 : 0} ${masterAt} ${phonesAt}`);
    this.outputs = { mixing: opts.mixing, channels: this.opened.channels };
  }
}
