// Production's sound in the page (Web Audio): the output used when Perform runs on the
// browser's audio. Strips, devices, clip voices and previews; engine.js does the timing.
// out-native.js is the same on Crate's native engine.
import { applyDevice, createDevice, disposeDevice } from "./fx/devices.js";
import { gainOf, srcUrl } from "./units.js";

export class WebOut {
  constructor(studio) { this.studio = studio; this.tracks = new Map(); this.returns = new Map(); this.kind = "web"; }

  // shares the Perform engine's context and output where possible
  async start(perf) {
    const web = perf.backend?.kind === "web";
    this.ctx = web ? perf.backend.ctx : new AudioContext({ latencyHint: "interactive" });
    try { await this.ctx.audioWorklet.addModule(new URL("./fx/dynamics.worklet.js", import.meta.url)); } catch (e) { this.studio.emit("error", `Some effects couldn't load: ${e.message}`); }
    this.main = this.strip(web ? perf.backend.master : this.ctx.destination);  // with the decks: through their limiter
  }
  now() { return this.ctx.currentTime; }

  // ---- strips: every track, return and Main runs input → devices → volume → pan → out,
  // metered after the pan. A track's sends leave after its fader, into the returns' inputs.
  strip(out) {
    const input = this.ctx.createGain(), gain = this.ctx.createGain(), pan = this.ctx.createStereoPanner();
    input.connect(gain); gain.connect(pan); pan.connect(out);
    return { input, gain, pan, out, meter: meter(this.ctx, pan), fx: new Map(), links: [[input, gain]], wired: "", sends: new Map(), playing: null, queued: null, voices: [] };
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

  // `into`: the strip it plays out to, a group's or Main's (null for returns and Main itself)
  mix(x, o, audible, returns, into) {
    const now = this.ctx.currentTime;
    if (into && x.out !== into.input) { x.pan.disconnect(x.out); x.pan.connect(into.input); x.out = into.input; }
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

  dropTrack(id) {
    const x = this.tracks.get(id);
    this.silence(x.voices, this.ctx.currentTime); this.chain(x, []); x.pan.disconnect(); this.tracks.delete(id);
  }

  // Devices in order between the strip's input and its fader; one switched off is skipped.
  // Only a changed order or on/off state rewires; turning a knob just sets parameters.
  chain(x, devices) {
    const bpm = this.studio.tempo();
    for (const [id, inst] of x.fx) if (!devices.some((d) => d.id === id)) { disposeDevice(inst); x.fx.delete(id); }
    for (const d of devices) {
      let inst = x.fx.get(d.id);
      if (!inst) {
        try { inst = createDevice(this.ctx, d.type); } catch (e) { this.studio.emit("error", `${d.type} couldn't start: ${e.message}`); }
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

  // synced delays and LFOs follow the tempo
  retempo(bpm) {
    for (const x of [this.main, ...this.tracks.values(), ...this.returns.values()]) {
      for (const inst of x.fx.values()) if (inst.def.tempo) { inst.set(inst.last, new Set(["bpm"]), bpm); inst.bpm = bpm; }
    }
  }

  // ---- audio for clips, and the voices that play it
  async decode(src) {
    const r = await fetch(srcUrl(src));
    if (!r.ok) throw new Error("That sound isn't there any more");
    return this.ctx.decodeAudioData(await r.arrayBuffer());
  }
  // one pass of a clip: `len` seconds of the buffer from `from`, or to its end when null
  voice(x, buf, when, from, rate, len, voices) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.playbackRate.value = rate; s.connect(x.input);
    if (len != null) s.start(when, from, len); else s.start(when, from);
    s.onended = () => { const i = voices.indexOf(s); if (i >= 0) voices.splice(i, 1); };
    return s;
  }
  // a stopped clip ends 5 ms after `when` rather than clicking
  silence(voices, when) { for (const v of voices.splice(0)) { try { v.stop(when + 0.005); } catch { /* already stopped */ } } }

  // a preview from the browser: straight out, unstretched, one at a time
  preview(buf) {
    this.stopPreview();
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.main.gain); s.start();
    this.previewing = s;
  }
  stopPreview() { this.previewing?.stop(); this.previewing = null; }
}

function meter(ctx, node) {
  const a = ctx.createAnalyser(); a.fftSize = 512; node.connect(a);
  const buf = new Float32Array(a.fftSize);
  return () => { a.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); return m; };
}
