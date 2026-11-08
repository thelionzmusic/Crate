// One deck of Crate's player, running on the audio thread.
//
// The track arrives once as interleaved 16-bit stereo at the context's sample rate.
//   vinyl     pitch follows tempo; cubic Hermite interpolation, any speed
//   key lock  tempo changes, pitch doesn't; WSOLA (overlapping grains, each placed where it
//             lines up best with the previous one, so beats and tones stay intact)
// Jumps (seek, hot cue) fade out and in over ~2 ms so nothing clicks.
//
// State is shared with the main thread through a Float64Array (SharedArrayBuffer when the
// page is cross-origin isolated): this thread writes the position every block and reads the
// target rate, so steady playback and sync corrections send no messages at all. Discrete
// commands (load, play, seek, loop) arrive as messages. Nothing in process() allocates.

const FADE = 96;                       // frames for a declick fade
const INV = 1 / 32768;
// shared slots
const POS = 0, RATE = 1, PLAYING = 2, TIME = 3, TARGET = 4;  // same layout as engine.js

class Deck extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.sh = o.shared ? new Float64Array(o.shared) : new Float64Array(8);
    this.shared = !!o.shared;
    this.sh[TARGET] = 1;
    this.pcm = null; this.frames = 0;
    this.pos = 0; this.rate = 1; this.playing = false; this.keylock = false; this.loop = null;
    this.gain = 0; this.want = 0; this.pendingSeek = -1; this.block = 0;
    // WSOLA: ~40 ms grains, 50% overlap, ±8 ms search
    const n = Math.round(sampleRate * 0.04) & ~1;
    this.N = n; this.Hs = n / 2; this.delta = Math.round(sampleRate * 0.008);
    this.win = new Float32Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);  // periodic Hann: sums to 1 at 50% overlap
    this.olaL = new Float32Array(n); this.olaR = new Float32Array(n);
    this.outL = new Float32Array(n * 2); this.outR = new Float32Array(n * 2); this.outN = 0;
    this.apos = 0; this.prev = -1;
    this.port.onmessage = (e) => this.on(e.data);
    for (const m of o.init || []) this.on(m);  // starting state, e.g. offline renders
  }

  on(m) {
    switch (m.type) {
      case "load": this.pcm = m.pcm; this.frames = m.pcm.length >> 1; this.playing = false; this.gain = this.want = 0; this.loop = null; this.jump(m.at || 0); break;
      case "unload": this.pcm = null; this.frames = 0; this.playing = false; break;
      case "play": if (this.pcm) { this.playing = true; this.want = 1; } break;
      case "pause": this.want = 0; break;
      case "seek": if (this.playing && this.gain > 0) { this.pendingSeek = m.frame; this.want = 0; } else this.jump(m.frame); break;
      case "rate": this.sh[TARGET] = m.rate; if (m.now) this.rate = m.rate; break;   // when memory isn't shared
      case "keylock": this.keylock = !!m.on; this.resetStretch(); break;
      case "loop": this.loop = m.loop; break;
    }
  }

  jump(frame) { this.pos = Math.max(0, Math.min(this.frames - 1, frame)); this.resetStretch(); }
  resetStretch() { this.apos = this.pos; this.prev = -1; this.outN = 0; this.olaL.fill(0); this.olaR.fill(0); }

  wrapLoop() {
    const lp = this.loop; if (!lp) return;
    const len = lp[1] - lp[0];
    if (len > 0 && this.pos >= lp[1]) { this.pos -= len; if (this.keylock) { this.apos -= len; if (this.prev >= 0) this.prev -= len; } }
  }

  // correlation of mono sums: natural continuation at `a` against a candidate at `b`
  score(a, b, len, step) {
    const p = this.pcm, f = this.frames;
    let j0 = 0, j1 = len;
    if (a < 0) j0 = Math.max(j0, -a); if (b < 0) j0 = Math.max(j0, -b);
    j1 = Math.min(j1, f - a, f - b);
    let s = 0;
    for (let j = j0; j < j1; j += step) { const ia = (a + j) << 1, ib = (b + j) << 1; s += (p[ia] + p[ia + 1]) * (p[ib] + p[ib + 1]); }
    return s;
  }

  // WSOLA: one hop of Hs frames into the output FIFO
  grain() {
    const { N, Hs, delta, win, pcm, frames } = this;
    let start = Math.round(this.apos);
    if (this.prev >= 0) {
      const nat = this.prev + Hs;
      let best = 0, top = -Infinity;
      for (let k = -delta; k <= delta; k += 4) { const s = this.score(nat, start + k, Hs, 4); if (s > top) { top = s; best = k; } }
      const c0 = best;
      for (let k = Math.max(-delta, c0 - 3); k <= Math.min(delta, c0 + 3); k++) { if (k === c0) continue; const s = this.score(nat, start + k, Hs, 2); if (s > top) { top = s; best = k; } }
      start += best;
    }
    const oL = this.olaL, oR = this.olaR, j0 = Math.max(0, -start), j1 = Math.min(N, frames - start);
    for (let j = j0; j < j1; j++) { const w = win[j] * INV, i = (start + j) << 1; oL[j] += w * pcm[i]; oR[j] += w * pcm[i + 1]; }
    const at = this.outN;
    this.outL.set(oL.subarray(0, Hs), at); this.outR.set(oR.subarray(0, Hs), at); this.outN += Hs;
    oL.copyWithin(0, Hs); oR.copyWithin(0, Hs); oL.fill(0, N - Hs); oR.fill(0, N - Hs);
    this.prev = start; this.apos += Hs * this.rate; this.pos = start + Hs;
  }

  // vinyl: cubic Hermite, rate gliding across the block so tempo moves never zipper
  vinyl(L, R, n, r0, r1) {
    const p = this.pcm, last = this.frames - 3;
    for (let i = 0; i < n; i++) {
      const x = this.pos, k = Math.floor(x), f = x - k;
      if (k >= 1 && k <= last) {
        const b = k << 1;
        for (let ch = 0; ch < 2; ch++) {
          const a0 = p[b - 2 + ch] * INV, a1 = p[b + ch] * INV, a2 = p[b + 2 + ch] * INV, a3 = p[b + 4 + ch] * INV;
          const c1 = 0.5 * (a2 - a0), c2 = a0 - 2.5 * a1 + 2 * a2 - 0.5 * a3, c3 = 0.5 * (a3 - a0) + 1.5 * (a1 - a2);
          (ch ? R : L)[i] = ((c3 * f + c2) * f + c1) * f + a1;
        }
      } else { L[i] = 0; R[i] = 0; }
      this.pos += r0 + (r1 - r0) * (i / n);
      if (this.loop !== null) this.wrapLoop();
    }
  }

  process(_, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const target = this.sh[TARGET];
    if (!this.pcm || (!this.playing && this.gain === 0)) { L.fill(0); if (R !== L) R.fill(0); this.publish(); return true; }
    if (this.keylock && target > 0.25 && target < 2 && Math.abs(target - 1) > 0.0005) {
      this.rate = target;
      while (this.outN < n) { this.grain(); this.wrapLoop(); }
      L.set(this.outL.subarray(0, n)); R.set(this.outR.subarray(0, n));
      this.outL.copyWithin(0, n, this.outN); this.outR.copyWithin(0, n, this.outN); this.outN -= n;
    } else {
      if (this.outN) this.resetStretch();
      this.vinyl(L, R, n, this.rate, target);
      this.rate = target; this.apos = this.pos;
    }
    if (this.gain !== this.want || this.gain !== 1) this.declick(L, R, n);
    if (this.pos >= this.frames) { this.playing = false; this.want = this.gain = 0; this.pos = this.frames; this.port.postMessage({ type: "ended" }); }
    this.publish();
    return true;
  }

  declick(L, R, n) {
    for (let i = 0; i < n; i++) {
      if (this.gain !== this.want) {
        this.gain += this.want > this.gain ? 1 / FADE : -1 / FADE;
        if (Math.abs(this.gain - this.want) < 1 / FADE) this.gain = this.want;
        if (this.gain === 0) {
          if (this.pendingSeek >= 0) { this.jump(this.pendingSeek); this.pendingSeek = -1; this.want = 1; }
          else this.playing = false;
        }
      }
      L[i] *= this.gain; R[i] *= this.gain;
    }
  }

  publish() {
    const sh = this.sh;
    sh[POS] = this.pos; sh[RATE] = this.rate; sh[PLAYING] = this.playing && this.want > 0 ? 1 : 0; sh[TIME] = currentTime;
    // without shared memory, report about every 11 ms instead
    if (!this.shared && ++this.block % 4 === 0) this.port.postMessage({ type: "state", s: [sh[POS], sh[RATE], sh[PLAYING], sh[TIME]] });
  }
}

registerProcessor("crate-deck", Deck);
