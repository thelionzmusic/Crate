// An instrument in the browser engine: one of native/synth's synths as WebAssembly, run in an
// AudioWorklet. Notes arrive as messages with the frame they start or end on and are played on
// that frame, as the native engine does. One processor per instrument on a track.
class CrateInstrument extends AudioWorkletProcessor {
  constructor({ processorOptions: { module } }) {
    super();
    const x = new WebAssembly.Instance(module, {}).exports;
    x.__wasm_call_ctors(); x.init(sampleRate);
    const bytes = new Uint8Array(x.memory.buffer, x.keys(), 8192), names = [];  // ASCII, each ended by a zero (no TextDecoder in a worklet)
    for (let i = 0, k = ""; names.length < x.count(); i++) { if (bytes[i]) k += String.fromCharCode(bytes[i]); else { names.push(k); k = ""; } }
    this.x = x; this.index = new Map(names.map((k, i) => [k, i]));
    this.L = new Float32Array(x.memory.buffer, x.left(), 128); this.R = new Float32Array(x.memory.buffer, x.right(), 128);
    this.events = [];  // [frame, on, id, note, velocity], in order; an end before a start on the same frame
    this.open = true;
    this.port.onmessage = ({ data: m }) => {
      if (m.set) for (const [k, v] of m.set) { const i = this.index.get(k); if (i !== undefined) x.set(i, v); }
      if (m.tempo) x.tempo(m.tempo);
      if (m.on) this.queue([m.on[3], 1, m.on[0], m.on[1], m.on[2]]);
      if (m.off) { const [id, at] = m.off; this.events = this.events.filter((e) => !(e[1] && e[2] === id && e[0] >= at)); this.queue([at, 0, id, 0, 0]); }
      if (m.release) { this.events = []; x.releaseAll(); }
      if ("sample" in m && x.sampleSet) {  // a sample to play from: copied into the module's memory
        const n = Math.min(m.sample?.length || 0, x.sampleMax());
        if (n) new Float32Array(x.memory.buffer, x.sampleData(), n).set(m.sample.subarray(0, n));
        x.sampleSet(n);
      }
      if (m.close) this.open = false;
    };
  }
  queue(e) {
    let i = this.events.length;
    while (i > 0 && (this.events[i - 1][0] > e[0] || (this.events[i - 1][0] === e[0] && this.events[i - 1][1] > e[1]))) i--;
    this.events.splice(i, 0, e);
  }
  process(_, outputs) {
    const [L, R] = outputs[0], n = L.length, x = this.x;
    let done = 0;
    while (this.events.length && this.events[0][0] < currentFrame + n) {
      const [at, on, id, note, vel] = this.events.shift(), k = Math.min(n, Math.max(done, at - currentFrame));
      if (k > done) { this.render(L, R, done, k); done = k; }
      if (on) x.noteOn(id, note, vel); else x.noteOff(id);
    }
    if (done < n) this.render(L, R, done, n);
    return this.open;
  }
  render(L, R, a, b) {
    this.x.render(b - a);
    L.set(this.L.subarray(0, b - a), a); (R || L).set(this.R.subarray(0, b - a), a);
  }
}
registerProcessor("crate-instrument", CrateInstrument);
