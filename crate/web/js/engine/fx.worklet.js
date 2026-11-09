// Bit crusher: reduces bit depth and holds samples to drop the sample rate.
// Parameters are k-rate (one value per block); nothing allocates in process().
class Crush extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "bits", defaultValue: 16, minValue: 2, maxValue: 16, automationRate: "k-rate" },
      { name: "hold", defaultValue: 1, minValue: 1, maxValue: 32, automationRate: "k-rate" }];
  }
  constructor() { super(); this.held = [0, 0]; this.count = 0; }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input.length) { for (const ch of output) ch.fill(0); return true; }
    const steps = 2 ** (params.bits[0] - 1), hold = Math.round(params.hold[0]), n = output[0].length;
    let count = this.count;
    for (let i = 0; i < n; i++) {
      if (count <= 0) {
        for (let c = 0; c < output.length; c++) { const x = (input[c] || input[0])[i]; this.held[c] = Math.round(x * steps) / steps; }
        count = hold;
      }
      count--;
      for (let c = 0; c < output.length; c++) output[c][i] = this.held[c];
    }
    this.count = count;
    return true;
  }
}
registerProcessor("crate-crush", Crush);
