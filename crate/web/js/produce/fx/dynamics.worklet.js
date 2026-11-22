// Crate's own dynamics and character processors, sample-accurate on the audio thread.
// Every processor is stereo in, stereo out, reads its settings as k-rate parameters and,
// where it has a meter, reports it about 30 times a second over its port.

const amp = (db) => 10 ** (db / 20);
const dbOf = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);
const coef = (ms) => Math.exp(-1 / (Math.max(ms, 0.01) * 0.001 * sampleRate));
const param = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });

class Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.alive = true; this.tick = 0;
    this.port.onmessage = (e) => { if (e.data === "close") this.alive = false; };
  }
  report(v) { if ((this.tick += 128) >= sampleRate / 30) { this.tick = 0; this.port.postMessage(v); } }
  // the input as two channels (mono doubled), or null when nothing is connected
  stereo(input) { return input.length ? [input[0], input[1] || input[0]] : null; }
}

// Compressor: feed-forward, stereo-linked, peak or RMS detection, soft knee, make-up gain
// and parallel mix. A second input, when connected, is the sidechain.
class Compressor extends Processor {
  static get parameterDescriptors() {
    return [param("threshold", -20, -60, 0), param("ratio", 4, 1, 40), param("knee", 6, 0, 24), param("attack", 10, 0.05, 200),
      param("release", 100, 5, 2000), param("makeup", 0, -12, 24), param("mix", 1, 0, 1), param("rms", 0, 0, 1)];
  }
  constructor() { super(); this.env = 0; this.ms = 0; }
  process(inputs, [out], p) {
    const x = this.stereo(inputs[0]);
    if (!x) return this.alive;
    const key = this.stereo(inputs[1] || []) || x, n = out[0].length;
    const th = p.threshold[0], slope = 1 / p.ratio[0] - 1, knee = p.knee[0], mix = p.mix[0], make = p.makeup[0], rms = p.rms[0] >= 0.5;
    const att = coef(p.attack[0]), rel = coef(p.release[0]), avg = coef(10);
    let most = 0;
    for (let i = 0; i < n; i++) {
      let lvl = Math.max(Math.abs(key[0][i]), Math.abs(key[1][i]));
      if (rms) { this.ms = avg * this.ms + (1 - avg) * lvl * lvl; lvl = Math.sqrt(this.ms); }
      const over = dbOf(lvl) - th;
      const gr = 2 * over < -knee ? 0 : knee > 0 && 2 * Math.abs(over) <= knee ? slope * (over + knee / 2) ** 2 / (2 * knee) : slope * over;
      this.env = gr < this.env ? att * this.env + (1 - att) * gr : rel * this.env + (1 - rel) * gr;
      if (this.env < most) most = this.env;
      const g = amp(this.env + make) * mix + (1 - mix);
      out[0][i] = x[0][i] * g; out[1][i] = x[1][i] * g;
    }
    this.report(most);
    return this.alive;
  }
}

// Gate: opens above the threshold, closes once the level falls `return` dB under it and the
// hold time has passed; closed, it turns the sound down to the floor rather than to nothing.
class Gate extends Processor {
  static get parameterDescriptors() {
    return [param("threshold", -40, -80, 0), param("ret", 3, 0, 24), param("attack", 0.1, 0.02, 100), param("hold", 20, 0, 500),
      param("release", 100, 1, 2000), param("floor", -80, -80, 0)];
  }
  constructor() { super(); this.open = false; this.held = 0; this.g = 0; this.peak = 0; }
  process(inputs, [out], p) {
    const x = this.stereo(inputs[0]);
    if (!x) return this.alive;
    const n = out[0].length, on = amp(p.threshold[0]), off = amp(p.threshold[0] - p.ret[0]), floor = p.floor[0] <= -80 ? 0 : amp(p.floor[0]);
    const att = coef(p.attack[0]), rel = coef(p.release[0]), fall = coef(1), hold = p.hold[0] * 0.001 * sampleRate;
    for (let i = 0; i < n; i++) {
      this.peak = Math.max(Math.max(Math.abs(x[0][i]), Math.abs(x[1][i])), this.peak * fall);
      if (this.peak >= on) { this.open = true; this.held = hold; } else if (this.open && this.peak < off && --this.held <= 0) this.open = false;
      const to = this.open ? 1 : floor;
      this.g = to > this.g ? att * this.g + (1 - att) * to : rel * this.g + (1 - rel) * to;
      out[0][i] = x[0][i] * this.g; out[1][i] = x[1][i] * this.g;
    }
    this.report(this.open ? 1 : 0);
    return this.alive;
  }
}

// Limiter: brickwall with 1.5 ms lookahead. The gain each sample needs is held at its lowest
// over the lookahead window, released smoothly, then averaged over the same window, so the
// gain is already down when a peak arrives, with no distortion from a sudden step.
class Limiter extends Processor {
  static get parameterDescriptors() { return [param("gain", 0, 0, 24), param("ceiling", -0.3, -24, 0), param("release", 50, 1, 1000)]; }
  constructor() {
    super();
    this.w = Math.max(2, Math.round(0.0015 * sampleRate));
    this.need = new Float32Array(this.w).fill(1); this.box = new Float32Array(this.w).fill(1); this.sum = this.w;
    this.dl = [new Float32Array(this.w - 1), new Float32Array(this.w - 1)];
    this.i = 0; this.j = 0; this.rel = 1;
  }
  process(inputs, [out], p) {
    const x = this.stereo(inputs[0]) || [new Float32Array(out[0].length), new Float32Array(out[0].length)];
    const n = out[0].length, w = this.w, d = w - 1, gin = amp(p.gain[0]), ceil = amp(p.ceiling[0]), rc = coef(p.release[0]);
    let most = 1;
    for (let k = 0; k < n; k++) {
      const a = x[0][k] * gin, b = x[1][k] * gin, pk = Math.max(Math.abs(a), Math.abs(b));
      this.need[this.i] = pk > ceil ? ceil / pk : 1;
      let m = 1;
      for (let q = 0; q < w; q++) if (this.need[q] < m) m = this.need[q];
      this.rel = m < this.rel ? m : m + (this.rel - m) * rc;
      this.sum += this.rel - this.box[this.i]; this.box[this.i] = this.rel;
      if (!(this.i = (this.i + 1) % w)) { this.sum = 0; for (const v of this.box) this.sum += v; }  // keep the running sum honest
      const g = Math.min(1, this.sum / w);
      if (g < most) most = g;
      const ya = this.dl[0][this.j], yb = this.dl[1][this.j];
      this.dl[0][this.j] = a; this.dl[1][this.j] = b; this.j = (this.j + 1) % d;
      out[0][k] = Math.max(-ceil, Math.min(ceil, ya * g)); out[1][k] = Math.max(-ceil, Math.min(ceil, yb * g));
    }
    this.report(dbOf(most));
    return this.alive;
  }
}

// Redux: fewer bits and a lower sample rate, for grit and aliasing on purpose
class Redux extends Processor {
  static get parameterDescriptors() { return [param("bits", 16, 1, 16), param("down", 1, 1, 40), param("mix", 1, 0, 1)]; }
  constructor() { super(); this.phase = 0; this.held = [0, 0]; }
  process(inputs, [out], p) {
    const x = this.stereo(inputs[0]);
    if (!x) return this.alive;
    const steps = 2 ** (p.bits[0] - 1), down = p.down[0], mix = p.mix[0];
    for (let i = 0; i < out[0].length; i++) {
      if ((this.phase += 1) >= down) {
        this.phase -= down;
        for (let c = 0; c < 2; c++) this.held[c] = Math.round(x[c][i] * steps) / steps;
      }
      for (let c = 0; c < 2; c++) out[c][i] = x[c][i] * (1 - mix) + this.held[c] * mix;
    }
    return this.alive;
  }
}

// Utility: gain, stereo width (0 mono, 1 as is, 4 wide), balance, phase per side, DC filter
class Utility extends Processor {
  static get parameterDescriptors() {
    return [param("gain", 0, -35, 35), param("width", 1, 0, 4), param("balance", 0, -1, 1), param("mono", 0, 0, 1),
      param("flipL", 0, 0, 1), param("flipR", 0, 0, 1), param("dc", 0, 0, 1)];
  }
  constructor() { super(); this.dcIn = [0, 0]; this.dcOut = [0, 0]; }
  process(inputs, [out], p) {
    const x = this.stereo(inputs[0]);
    if (!x) return this.alive;
    const g = amp(p.gain[0]), width = p.mono[0] >= 0.5 ? 0 : p.width[0], bal = p.balance[0], dc = p.dc[0] >= 0.5, r = 1 - 2 * Math.PI * 5 / sampleRate;
    const gl = g * (p.flipL[0] >= 0.5 ? -1 : 1) * (bal > 0 ? 1 - bal : 1), gr = g * (p.flipR[0] >= 0.5 ? -1 : 1) * (bal < 0 ? 1 + bal : 1);
    for (let i = 0; i < out[0].length; i++) {
      let l = x[0][i], rr = x[1][i];
      if (dc) {
        const yl = l - this.dcIn[0] + r * this.dcOut[0], yr = rr - this.dcIn[1] + r * this.dcOut[1];
        this.dcIn[0] = l; this.dcIn[1] = rr; this.dcOut[0] = yl; this.dcOut[1] = yr; l = yl; rr = yr;
      }
      const mid = (l + rr) / 2, side = (l - rr) / 2 * width;
      out[0][i] = (mid + side) * gl; out[1][i] = (mid - side) * gr;
    }
    return this.alive;
  }
}

registerProcessor("crate-comp", Compressor);
registerProcessor("crate-gate", Gate);
registerProcessor("crate-limiter", Limiter);
registerProcessor("crate-redux", Redux);
registerProcessor("crate-utility", Utility);
