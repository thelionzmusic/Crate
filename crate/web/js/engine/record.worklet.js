// Mix recorder tap: copies the master into interleaved stereo blocks of about a second and
// hands them to the page, which streams them to disk. Passes nothing on (it's a dead end).
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(sampleRate * 2); this.at = 0; this.port.onmessage = () => this.flush(); }
  flush() { if (this.at) { this.port.postMessage(this.buf.slice(0, this.at), []); this.at = 0; } }
  process(inputs) {
    const [l, r = l] = inputs[0] || [];
    if (!l) return true;
    for (let i = 0; i < l.length; i++) { this.buf[this.at++] = l[i]; this.buf[this.at++] = r[i]; }
    if (this.at >= this.buf.length) this.flush();
    return true;
  }
}
registerProcessor("crate-record", Tap);
