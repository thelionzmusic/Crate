// Crate Drum: drums made from scratch, in the manner of Kick 2 and Live 13's Drum Synth. Four
// layers, each with its own envelope:
//   body   a pitched oscillator (sine to saw) with a pitch drop whose depth, time and curve you
//          set; its own drive. The kick's whole sound and the snare's shell. It can follow the
//          keyboard, so a kick plays in key (C1 is its tuning).
//   click  the transient: a noise tick, a blip or a beater
//   noise  filtered noise, with clap-style bursts
//   metal  six square waves at the 808's hi-hat ratios, high-passed
// then drive, a hard clipper and low and high shelves. Envelopes are shaped by a curve and end
// at exactly zero, as Kick 2's do. Drums are one-shots: a note's end is ignored; choke cuts the
// last hit when the next starts.
//
// No allocation and no C library, like fm.hpp: the same file builds into crate-engine and drum.wasm.
#pragma once
#include "math.hpp"
#include "parts.hpp"
#include "wavetable.hpp"

namespace synth {

#define CRATE_DRUM_PARAMS(X)                                                                                      \
  X(model, 0, 8, 0) X(tune, 20, 800, 50) X(key, 0, 1, 1) X(bwave, 0, 2, 0)                                         \
  X(bpitch, 0, 72, 36) X(bptime, 1, 1000, 40) X(bpcurve, 0, 1, 0.6)                                               \
  X(battack, 0, 50, 0) X(bhold, 0, 500, 20) X(bdecay, 10, 4000, 450) X(bcurve, 0, 1, 0.5) X(blevel, 0, 1, 1) X(bdrive, 0, 1, 0) \
  X(click, 0, 1, 0.3) X(ctype, 0, 2, 0) X(cdecay, 1, 50, 6) X(ctone, 500, 16000, 5000)                             \
  X(noise, 0, 1, 0) X(nfilter, 0, 2, 1) X(ncut, 100, 16000, 4000) X(nres, 0, 1, 0.2) X(nattack, 0, 50, 0)          \
  X(ndecay, 5, 3000, 150) X(nclap, 1, 4, 1) X(nspace, 3, 30, 10)                                                  \
  X(metal, 0, 1, 0) X(mfreq, 100, 1000, 400) X(mdecay, 5, 4000, 80) X(mtone, 1000, 16000, 7000)                   \
  X(drive, 0, 1, 0) X(clip, 0, 1, 0) X(low, -12, 12, 0) X(high, -12, 12, 0) X(vel, 0, 1, 0.5) X(choke, 0, 1, 1)     \
  X(level, 0, 1, 0.7)

namespace drum {
#define X(n, lo, hi, def) P_##n,
enum Param : int { CRATE_DRUM_PARAMS(X) NPARAMS };
#undef X
#define X(n, lo, hi, def) #n "\0"
inline constexpr char KEYS[] = CRATE_DRUM_PARAMS(X);
#undef X
#define X(n, lo, hi, def) static_cast<float>(def),
inline constexpr float DEFAULTS[NPARAMS] = {CRATE_DRUM_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(lo),
inline constexpr float MINS[NPARAMS] = {CRATE_DRUM_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(hi),
inline constexpr float MAXS[NPARAMS] = {CRATE_DRUM_PARAMS(X)};
#undef X

constexpr int MAXV = 8, METALS = 6;
constexpr float METAL[METALS] = {1, 1.483f, 1.800f, 2.546f, 2.630f, 3.897f};  // the 808's hat oscillators, from the lowest
}  // namespace drum

class Drum {
 public:
  static constexpr bool SAMPLES = false;
  static constexpr int COUNT = drum::NPARAMS;
  static const char* keys() { return drum::KEYS; }
  static const float* defaults() { return drum::DEFAULTS; }

  void init(float sampleRate) {
    buildTables();
    sr_ = sampleRate;
    for (int i = 0; i < drum::NPARAMS; i++) p_[i] = drum::DEFAULTS[i];
    for (auto& v : v_) v = Voice{};
    dirty_ = true;
  }
  void set(int k, float value) { if (k >= 0 && k < drum::NPARAMS) { p_[k] = clampf(value, drum::MINS[k], drum::MAXS[k]); dirty_ = true; } }
  void tempo(float) {}

  void noteOn(int, int note, float velocity) {
    if (dirty_) update();
    using namespace drum;
    if (p_[P_choke] >= 0.5f) for (auto& x : v_) if (x.active) x.fade = 1;  // the next hit cuts the last
    Voice* v = nullptr;
    for (auto& x : v_) if (!x.active && !v) v = &x;
    if (!v) for (auto& x : v_) if (!v || x.t > v->t) v = &x;  // the oldest
    *v = Voice{};
    v->active = true;
    v->gain = (1 - p_[P_vel] * (1 - clampf(velocity, 0, 1)));
    v->hz = p_[P_tune] * (p_[P_key] >= 0.5f ? exp2f_((static_cast<float>(note) - 36) / 12) : 1);
    v->metalHz = p_[P_mfreq] * (p_[P_key] >= 0.5f ? exp2f_((static_cast<float>(note) - 36) / 12 * 0.25f) : 1);  // hats track gently
  }
  void noteOff(int) {}
  void releaseAll() { for (auto& v : v_) if (v.active) v.fade = 1; }
  void silence() { for (auto& v : v_) v.active = false; }
  bool sounding() const { for (const auto& v : v_) if (v.active) return true; return false; }

  void render(float* L, float* R, int n) {
    if (dirty_) update();
    for (auto& v : v_) if (v.active) voice(v, L, R, n);
  }

 private:
  struct Voice {
    bool active = false;
    float t = 0, fade = 0, gain = 1, hz = 50, metalHz = 400;
    uint32_t ph = 0, mph[drum::METALS] = {}, cph = 0;
    Svf click, noise, metal, lowS, highS;
  };

  void update() {
    using namespace drum;
    dirty_ = false;
    const float ms = 1000.f / sr_;
    dt_ = ms;  // milliseconds a frame
    const float cg = tanf_(PI * minf(p_[P_ctone], sr_ * 0.45f) / sr_), ng = tanf_(PI * minf(p_[P_ncut], sr_ * 0.45f) / sr_), mg = tanf_(PI * minf(p_[P_mtone], sr_ * 0.45f) / sr_);
    setCoef(c_, cg, 1.4f); setCoef(n_, ng, 2 - 1.9f * p_[P_nres]); setCoef(m_, mg, 1.2f);
    setCoef(ls_, tanf_(PI * 90 / sr_), 1.41f); setCoef(hs_, tanf_(PI * minf(6000.f, sr_ * 0.4f) / sr_), 1.41f);
    lowG_ = exp2f_(p_[P_low] / 6.0206f) - 1; highG_ = exp2f_(p_[P_high] / 6.0206f) - 1;
  }
  struct Coef { float a1 = 1, a2 = 0, a3 = 0, k = 2; };
  static void setCoef(Coef& c, float g, float k) { c.k = k; c.a1 = 1 / (1 + g * (g + k)); c.a2 = g * c.a1; c.a3 = g * c.a2; }

  // a shaped fall from 1 to exactly 0 over `len`: curve 0 is a straight line, 1 a steep exponential-like drop
  static float fall(float x, float curve) { if (x >= 1) return 0; const float y = 1 - x; return exp2f_(log2f_(maxf(y, 1e-9f)) * (1 + curve * 7)); }

  void voice(Voice& v, float* L, float* R, int n) {
    using namespace drum;
    const float wave = p_[P_bwave], bl = p_[P_blevel], bdrive = 1 + p_[P_bdrive] * 10, bpost = 1 / tanhf_(bdrive * 0.7f + 1e-6f) * 0.7f;
    const float att = p_[P_battack], hold = p_[P_bhold], dec = p_[P_bdecay];
    const float click = p_[P_click], cdec = p_[P_cdecay];
    const int ctype = clampi(static_cast<int>(p_[P_ctype] + 0.5f), 0, 2), nmode = clampi(static_cast<int>(p_[P_nfilter] + 0.5f), 0, 2);
    const float noise = p_[P_noise], ndec = p_[P_ndecay], natt = p_[P_nattack], space = p_[P_nspace];
    const int bursts = clampi(static_cast<int>(p_[P_nclap] + 0.5f), 1, 4);
    const float metal = p_[P_metal], mdec = p_[P_mdecay];
    const float drive = 1 + p_[P_drive] * 12, dpost = 1 / tanhf_(drive * 0.6f + 1e-6f) * 0.6f, ceiling = 1 - p_[P_clip] * 0.75f;
    const float level = p_[P_level] * v.gain, toInc = 4294967296.f / sr_;
    // how long the voice lasts: its longest layer
    const float life = maxf(maxf(att + hold + dec, cdec), maxf(natt + ndec + (bursts - 1) * space, mdec)) + 5;
    for (int i = 0; i < n; i++) {
      const float t = v.t;
      // body: pitch falls from +bpitch semitones to the note over bptime, along its curve
      const float semis = p_[P_bpitch] * fall(t / p_[P_bptime], p_[P_bpcurve]);
      v.ph += static_cast<uint32_t>(minf(v.hz * exp2f_(semis / 12), sr_ * 0.45f) * toInc);
      const float benv = t < att ? t / maxf(att, 1e-3f) : t < att + hold ? 1 : fall((t - att - hold) / dec, p_[P_bcurve]);
      float body = 0;
      if (bl > 0 && benv > 0) {
        body = readWave(wave, levelFor(static_cast<uint32_t>(v.hz * exp2f_(semis / 12) * toInc)), v.ph) * benv * bl;
        if (p_[P_bdrive] > 0) body = tanhf_(body * bdrive) * bpost;
      }
      // click: a tick of noise, a blip or a beater
      float c = 0;
      if (click > 0 && t < cdec * 4) {
        const float e = expf_(-t / cdec * 2.3f) * click;
        if (ctype == 1) { v.cph += static_cast<uint32_t>(p_[P_ctone] * 0.5f * toInc); c = readWave(0, LEVELS - 1, v.cph) * e; }
        else c = v.click.run(rand_.bi(), c_.a1, c_.a2, c_.a3, c_.k, ctype == 0 ? 0 : 2) * e * 1.5f;
      }
      // noise: claps strike several times, the last one ringing out
      float nz = 0;
      if (noise > 0) {
        const float tail = t - (bursts - 1) * space;
        float e;
        if (tail < 0) { const float s = t - floorf_(t / space) * space; e = expf_(-s / (space * 0.3f)); }
        else e = (tail < natt ? tail / maxf(natt, 1e-3f) : 1) * expf_(-maxf(0, tail - natt) / ndec * 4.6f);
        nz = v.noise.run(rand_.bi(), n_.a1, n_.a2, n_.a3, n_.k, nmode == 0 ? 0 : nmode == 1 ? 1 : 2) * e * noise * 4;  // filtered noise loses most of its level: brought back up
      }
      // metal: six squares, high-passed, ringing down
      float mt = 0;
      if (metal > 0) {
        float m = 0;
        for (int k = 0; k < METALS; k++) { const uint32_t inc = static_cast<uint32_t>(v.metalHz * METAL[k] * toInc); v.mph[k] += inc; m += readWave(3, levelFor(inc), v.mph[k]); }
        mt = v.metal.run(m * (1.f / METALS), m_.a1, m_.a2, m_.a3, m_.k, 2) * expf_(-t / mdec * 4.6f) * metal * 5;  // likewise, high-passed
      }
      // the drum through drive, the clipper and the shelves
      float x = body + c + nz + mt;
      if (p_[P_drive] > 0) x = tanhf_(x * drive) * dpost;
      if (p_[P_clip] > 0) x = clampf(x * (1 + p_[P_clip] * 3), -ceiling, ceiling);
      if (lowG_ != 0) x += v.lowS.run(x, ls_.a1, ls_.a2, ls_.a3, ls_.k, 0) * lowG_;
      if (highG_ != 0) x += v.highS.run(x, hs_.a1, hs_.a2, hs_.a3, hs_.k, 2) * highG_;
      if (v.fade > 0) { v.fade -= dt_ / 4; if (v.fade <= 0) { v.active = false; return; } x *= v.fade; }  // a choked hit, gone in 4 ms
      x *= level;
      L[i] += x; R[i] += x;
      v.t += dt_;
      if (v.t > life) { v.active = false; return; }
    }
  }

  float sr_ = 48000, dt_ = 1000.f / 48000;
  float p_[drum::NPARAMS] = {};
  bool dirty_ = true;
  Voice v_[drum::MAXV];
  Coef c_, n_, m_, ls_, hs_;
  float lowG_ = 0, highG_ = 0;
  Rand rand_;
};

}  // namespace synth
