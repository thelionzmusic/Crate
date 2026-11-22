// One instrument as a WebAssembly module, for the browser engine's AudioWorklet
// (web/js/produce/instruments/instrument.worklet.js). make-wasm.sh builds one per synth, naming
// its header and class; the .wasm files are committed beside the page so Crate runs without a
// compiler.
#include SYNTH_HEADER

#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static SYNTH gSynth;
static float gL[128], gR[128];

EXPORT(init) void init(float sr) { gSynth.init(sr); }
EXPORT(set) void set(int k, float v) { gSynth.set(k, v); }
EXPORT(tempo) void tempo(float bpm) { gSynth.tempo(bpm); }
EXPORT(noteOn) void noteOn(int id, int note, float vel) { gSynth.noteOn(id, note, vel); }
EXPORT(noteOff) void noteOff(int id) { gSynth.noteOff(id); }
EXPORT(releaseAll) void releaseAll() { gSynth.releaseAll(); }
EXPORT(silence) void silence() { gSynth.silence(); }
EXPORT(sounding) int sounding() { return gSynth.sounding(); }
// n <= 128 frames into left() and right()
EXPORT(render) void render(int n) {
  for (int i = 0; i < n; i++) gL[i] = gR[i] = 0;
  gSynth.render(gL, gR, n);
}
EXPORT(left) float* left() { return gL; }
EXPORT(right) float* right() { return gR; }
EXPORT(keys) const char* keys() { return SYNTH::keys(); }
EXPORT(count) int count() { return SYNTH::COUNT; }

#ifdef SYNTH_SAMPLES
// a sample of yours: the page writes it (mono, at the context's rate) into sampleData() and calls
// sampleSet with its length; up to 2^21 frames, 43 s at 48 kHz
static float gSample[1 << 21];
EXPORT(sampleData) float* sampleData() { return gSample; }
EXPORT(sampleMax) int sampleMax() { return 1 << 21; }
EXPORT(sampleSet) void sampleSet(int frames) { gSynth.sample(gSample, frames < (1 << 21) ? frames : (1 << 21)); }
#endif
