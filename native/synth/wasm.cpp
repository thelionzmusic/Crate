// One instrument as a WebAssembly module, for the browser engine's AudioWorklet
// (web/js/produce/instruments/instrument.worklet.js). Build with make-wasm.sh; the .wasm is committed
// beside the page so Crate runs without a compiler. INSTRUMENT names the class, KEYS its
// parameter names.
#include "fm.hpp"

#ifndef INSTRUMENT
#define INSTRUMENT synth::Fm
#define KEYS synth::fm::KEYS
#define COUNT synth::fm::NPARAMS
#endif
#define EXPORT(name) extern "C" __attribute__((export_name(#name)))

static INSTRUMENT gSynth;
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
EXPORT(keys) const char* keys() { return KEYS; }
EXPORT(count) int count() { return COUNT; }
