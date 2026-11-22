// Crate's instruments as devices: what each is called and its parameters, and in the browser
// engine, an AudioWorklet running its wasm build. The native engine runs the same C++ itself.
import { FM_PARAMS } from "./fm.js";

export const INSTRUMENTS = {
  fm: { name: "Crate FM", cat: "Instruments", instrument: true, tempo: true, params: FM_PARAMS, wasm: "fm.wasm",
    help: "Four-operator FM with morphing wavetables, unison, a filter and a mod matrix. From plucks and keys to growls and 808s" },
};

const modules = new WeakMap();  // per audio context: compiled modules by type
// once per context, before any instrument is built there
export async function loadInstruments(ctx) {
  if (modules.has(ctx)) return;
  const [, ...built] = await Promise.all([
    ctx.audioWorklet.addModule(new URL("./instrument.worklet.js", import.meta.url)),
    ...Object.values(INSTRUMENTS).map((d) => WebAssembly.compileStreaming(fetch(new URL(d.wasm, import.meta.url)))),
  ]);
  modules.set(ctx, Object.fromEntries(Object.keys(INSTRUMENTS).map((k, i) => [k, built[i]])));
}

// a device instance: notes go in with the context time they start and how long they last
export function buildInstrument(ctx, type) {
  const module = modules.get(ctx)?.[type];
  if (!module) throw new Error("Instruments haven't loaded");
  const node = new AudioWorkletNode(ctx, "crate-instrument", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module } });
  const frame = (t) => Math.round(t * ctx.sampleRate), post = (m) => node.port.postMessage(m);
  return {
    input: node, output: node,
    set(v, changed, bpm) {
      const set = [...changed].filter((k) => k in v).map((k) => [k, +v[k]]);
      if (set.length) post({ set });
      if (changed.has("bpm")) post({ tempo: bpm });
    },
    note(id, pitch, vel, when, dur) { post({ on: [id, pitch, vel, frame(when)] }); post({ off: [id, frame(when + dur)] }); },
    off(id, when) { post({ off: [id, frame(when)] }); },
    releaseAll() { post({ release: true }); },
    dispose() { post({ close: true }); },
  };
}
