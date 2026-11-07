// One deck of Crate's player, running on the audio thread.
//
// The track arrives once as interleaved 16-bit stereo at the context's sample rate.
// Two ways of reading it:
//   vinyl     pitch follows tempo; cubic interpolation, any speed, either direction
//   key lock  tempo changes, pitch doesn't; WSOLA (overlapping grains, each placed where
//             it lines up best with the last one, so beats and tones stay intact)
// Every jump (seek, hot cue, loop entry from outside) fades out and in over ~2 ms,
// so nothing clicks.

const FADE = 96;               // frames for a declick fade
const REPORT_EVERY = 4;        // blocks between position reports (~11 ms)

class Deck extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.pcm = null; this.frames = 0;
    this.pos = 0; this.rate = 1; this.target = 1; this.playing = false; this.keylock = false;
    this.loop = null;          // [in, out] in frames
    this.gain = 0; this.want = 0; this.pendingSeek = null;
    this.block = 0;
    // WSOLA state, sized for the context's rate: ~40 ms grains, 50% overlap
    const n = Math.round(sampleRate * 0.04) & ~1;
    this.N = n; this.Hs = n / 2; this.delta = Math.round(sampleRate * 0.008);
    this.win = new Float32Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);  // periodic Hann: sums to 1 at 50% overlap
    this.olaL = new Float32Array(n); this.olaR = new Float32Array(n);
    this.outL = new Float32Array(n * 2); this.outR = new Float32Array(n * 2); this.outN = 0; this.outR0 = 0;
    this.apos = 0; this.prev = -1;
    this.port.onmessage = (e) => this.on(e.data);
    for (const m of (options && options.processorOptions && options.processorOptions.init) || []) this.on(m);  // starting state, e.g. offline renders
  }

  on(m) {
    switch (m.type) {
      case "load":
        this.pcm = m.pcm; this.frames = m.pcm.length / 2; this.playing = false; this.gain = 0; this.want = 0;
        this.loop = null; this.jump(m.at || 0); break;
      case "unload": this.pcm = null; this.frames = 0; this.playing = false; break;
      case "play": if (this.pcm) { this.playing = true; this.want = 1; } break;
      case "pause": this.want = 0; break;
      case "seek": if (this.playing && this.gain > 0) { this.pendingSeek = m.frame; this.want = 0; } else this.jump(m.frame); break;
      case "rate": this.target = m.rate; if (m.now) this.rate = m.rate; break;
      case "keylock": this.keylock = !!m.on; this.resetStretch(); break;
      case "loop": this.loop = m.loop; break;
    }
  }

  jump(frame) { this.pos = Math.max(0, Math.min(this.frames - 1, frame)); this.resetStretch(); }
  resetStretch() { this.apos = this.pos; this.prev = -1; this.outN = 0; this.olaL.fill(0); this.olaR.fill(0); }

  // ---- sample access (16-bit interleaved, out of range reads silence)
  s(i, ch) { return i < 0 || i >= this.frames ? 0 : this.pcm[i * 2 + ch] * (1 / 32768); }

  // cubic Hermite at a fractional frame
  hermite(x, ch) {
    const i = Math.floor(x), f = x - i;
    const a = this.s(i - 1, ch), b = this.s(i, ch), c = this.s(i + 1, ch), d = this.s(i + 2, ch);
    const c1 = 0.5 * (c - a), c2 = a - 2.5 * b + 2 * c - 0.5 * d, c3 = 0.5 * (d - a) + 1.5 * (b - c);
    return ((c3 * f + c2) * f + c1) * f + b;
  }

  wrapLoop() {
    const lp = this.loop; if (!lp) return;
    const len = lp[1] - lp[0];
    if (len > 0 && this.rate > 0 && this.pos >= lp[1]) { this.pos -= len; if (this.keylock) { this.apos -= len; if (this.prev >= 0) this.prev -= len; } }
  }

  // ---- WSOLA: produce one hop of Hs frames into the output FIFO
  grain() {
    const { N, Hs, delta, win, pcm } = this;
    let start = Math.round(this.apos);
    if (this.prev >= 0) {
      // where the last grain would naturally have continued; find the offset that matches it best
      const nat = this.prev + Hs;
      let best = 0, bestScore = -Infinity;
      const L = Hs, step = 4;
      for (let k = -delta; k <= delta; k += step) {   // coarse pass, decimated
        let sc = 0; const b = start + k;
        for (let j = 0; j < L; j += step) {
          const ia = nat + j, ib = b + j;
          if (ib < 0 || ib >= this.frames || ia < 0 || ia >= this.frames) continue;
          sc += (pcm[ia * 2] + pcm[ia * 2 + 1]) * (pcm[ib * 2] + pcm[ib * 2 + 1]);
        }
        if (sc > bestScore) { bestScore = sc; best = k; }
      }
      const c0 = best;                                  // fine pass around it
      for (let k = c0 - step + 1; k < c0 + step; k++) {
        if (k === c0 || k < -delta || k > delta) continue;
        let sc = 0; const b = start + k;
        for (let j = 0; j < L; j += 2) {
          const ia = nat + j, ib = b + j;
          if (ib < 0 || ib >= this.frames || ia < 0 || ia >= this.frames) continue;
          sc += (pcm[ia * 2] + pcm[ia * 2 + 1]) * (pcm[ib * 2] + pcm[ib * 2 + 1]);
        }
        if (sc > bestScore) { bestScore = sc; best = k; }
      }
      start += best;
    }
    const oL = this.olaL, oR = this.olaR;
    for (let j = 0; j < N; j++) { const w = win[j]; oL[j] += w * this.s(start + j, 0); oR[j] += w * this.s(start + j, 1); }
    // the first Hs frames are now complete
    const at = this.outN; this.outL.set(oL.subarray(0, Hs), at); this.outR.set(oR.subarray(0, Hs), at); this.outN += Hs;
    oL.copyWithin(0, Hs); oR.copyWithin(0, Hs); oL.fill(0, N - Hs); oR.fill(0, N - Hs);
    this.prev = start;
    this.apos += Hs * this.rate;
    this.pos = start + Hs;  // what's coming out now
  }

  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    if (!this.pcm || (!this.playing && this.gain === 0)) { L.fill(0); if (R !== L) R.fill(0); this.report(); return true; }
    const r0 = this.rate, r1 = this.target, stretch = this.keylock && r1 > 0.25 && r1 < 2 && Math.abs(r1 - 1) > 0.0005;
    if (stretch) {
      this.rate = r1;
      while (this.outN < n) { this.grain(); this.wrapLoop(); }
      L.set(this.outL.subarray(0, n)); R.set(this.outR.subarray(0, n));
      this.outL.copyWithin(0, n, this.outN); this.outR.copyWithin(0, n, this.outN); this.outN -= n;
    } else {
      if (this.outN) this.resetStretch();
      for (let i = 0; i < n; i++) {
        const r = r0 + (r1 - r0) * (i / n);          // glide across the block, no zipper noise
        L[i] = this.hermite(this.pos, 0); R[i] = this.hermite(this.pos, 1);
        this.pos += r; this.rate = r;
        if (this.loop) this.wrapLoop();
      }
      this.rate = r1; this.apos = this.pos;
    }
    // declick ramp
    for (let i = 0; i < n; i++) {
      if (this.gain !== this.want) {
        this.gain += this.want > this.gain ? 1 / FADE : -1 / FADE;
        if (Math.abs(this.gain - this.want) < 1 / FADE) this.gain = this.want;
        if (this.gain === 0) {
          if (this.pendingSeek !== null) { this.jump(this.pendingSeek); this.pendingSeek = null; this.want = 1; }
          else this.playing = false;
        }
      }
      L[i] *= this.gain; R[i] *= this.gain;
    }
    if (this.pos >= this.frames) { this.playing = false; this.want = 0; this.gain = 0; this.pos = this.frames; this.port.postMessage({ type: "ended" }); }
    this.report();
    return true;
  }

  report() {
    if (++this.block % REPORT_EVERY) return;
    this.port.postMessage({ type: "pos", pos: this.pos, rate: this.rate, playing: this.playing && this.want > 0, t: currentTime });
  }
}

registerProcessor("crate-deck", Deck);
