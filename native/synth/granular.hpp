// Crate Grain: a granular synth. Each note sprays short, windowed grains read from a source:
// where in it (position, spray), how it moves (scan: 1 plays through at its own speed, 0 freezes
// it, negative runs backwards), how long and how often (size, density, jitter), and how each one
// sounds (pitch, random pitch, octave and fifth jumps, reversal, window shape, stereo spread).
// Then a filter with its own envelope, an amp envelope and an LFO for position, cutoff, size and
// pitch.
//
// Sources: eight made here at start-up (choir, strings, glass, breath, bells, organ, vowels,
// metal), each a whole number of cycles long so it loops without a seam, or a sample of yours.
//
// No allocation and no C library, like fm.hpp: the same file builds into crate-engine and grain.wasm.
#pragma once
#include "math.hpp"
#include "parts.hpp"
#include "wavetable.hpp"

namespace synth {

#define CRATE_GRAIN_PARAMS(X)                                                                                     \
  X(source, 0, 8, 0) X(root, 24, 96, 60) X(pos, 0, 1, 0.25) X(spray, 0, 1, 0.1) X(scan, -2, 2, 0)                  \
  X(size, 5, 1000, 120) X(density, 1, 200, 30) X(jitter, 0, 1, 0.3)                                               \
  X(pitch, -24, 24, 0) X(prand, 0, 1, 0) X(jump, 0, 1, 0) X(rev, 0, 1, 0) X(shape, 0, 1, 1) X(pan, 0, 1, 0.5)       \
  X(ftype, 0, 5, 0) X(cutoff, 20, 20000, 20000) X(res, 0, 1, 0.1) X(fenv, -1, 1, 0)                              \
  X(aa, 0, 10, 0.02) X(ad, 0, 10, 1) X(as, 0, 1, 1) X(ar, 0, 10, 0.6)                                             \
  X(ma, 0, 10, 0.01) X(md, 0, 10, 1) X(ms, 0, 1, 0) X(mr, 0, 10, 0.5)                                            \
  X(lrate, 0.02, 20, 0.3) X(lshape, 0, 3, 0) X(lpos, 0, 1, 0) X(lcut, 0, 1, 0) X(lsize, 0, 1, 0) X(lpitch, 0, 1, 0) \
  X(vel, 0, 1, 0.5) X(level, 0, 1, 0.7)

namespace grain {
#define X(n, lo, hi, def) P_##n,
enum Param : int { CRATE_GRAIN_PARAMS(X) NPARAMS };
#undef X
#define X(n, lo, hi, def) #n "\0"
inline constexpr char KEYS[] = CRATE_GRAIN_PARAMS(X);
#undef X
#define X(n, lo, hi, def) static_cast<float>(def),
inline constexpr float DEFAULTS[NPARAMS] = {CRATE_GRAIN_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(lo),
inline constexpr float MINS[NPARAMS] = {CRATE_GRAIN_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(hi),
inline constexpr float MAXS[NPARAMS] = {CRATE_GRAIN_PARAMS(X)};
#undef X

constexpr int MAXV = 16, GRAINS = 24, CTRL = 16, BUILT = 8, SBITS = 16, SLEN = 1 << SBITS;
enum FType { F_OFF, F_LP12, F_LP24, F_HP12, F_BP, F_NOTCH };
}  // namespace grain

// the built-in sources, shared by every instance at one sample rate
inline float gGrainSrc[grain::BUILT][grain::SLEN];
inline float gGrainSrcRate = 0;

namespace detail {
// a sum of sines whose frequencies are whole numbers of cycles across the buffer, so it loops
// cleanly; amp(k, t) gives partial k's level at t (0..1 through the buffer), read every 64 frames
template <class Amp>
inline void partials(float* out, const double* cycles, int count, Amp amp, double phase0 = 0) {
  double re[64], im[64], c[64], s[64];
  for (int k = 0; k < count; k++) {
    const double w = 6.283185307179586 * cycles[k] / grain::SLEN;
    c[k] = cosd(w); s[k] = sind(w); re[k] = cosd(phase0 * k * 2.3); im[k] = sind(phase0 * k * 2.3);
  }
  float a[64];
  for (int i = 0; i < grain::SLEN; i++) {
    if ((i & 63) == 0) for (int k = 0; k < count; k++) a[k] = amp(k, static_cast<double>(i) / grain::SLEN);
    double x = 0;
    for (int k = 0; k < count; k++) { const double r = re[k] * c[k] - im[k] * s[k]; im[k] = re[k] * s[k] + im[k] * c[k]; re[k] = r; x += im[k] * a[k]; }
    out[i] += static_cast<float>(x);
  }
}
// a formant's weight at a frequency: a bump `width` Hz wide
inline double formant(double hz, double at, double width) { const double x = (hz - at) / width; return 1 / (1 + x * x); }
}  // namespace detail

inline void buildGrainSources(float sr) {
  using namespace grain;
  if (gGrainSrcRate == sr) return;
  for (auto& src : gGrainSrc) for (auto& x : src) x = 0;
  const double K = 2 * static_cast<double>(static_cast<long>(261.6256 * SLEN / sr / 2 + 0.5));  // C3 (MIDI 60), even, in whole cycles
  const double f0 = K * sr / SLEN;
  double cyc[64];
  Rand rnd;
  // 0 choir: 24 harmonics through a voice's formants, drifting from "ah" to "oh" and back, three voices
  for (int v = 0; v < 3; v++) {
    for (int k = 0; k < 24; k++) cyc[k] = (k + 1) * (K + (v - 1) * 2);
    detail::partials(gGrainSrc[0], cyc, 24, [&](int k, double t) {
      const double m = 0.5 - 0.5 * cosd(6.283185307179586 * t), hz = (k + 1) * f0;
      return (detail::formant(hz, 700 - 200 * m, 130) + 0.6 * detail::formant(hz, 1200 - 300 * m, 160) + 0.2 * detail::formant(hz, 2600, 300)) / (1 + k * 0.08);
    }, v * 1.7);
  }
  // 1 strings: three detuned saws
  for (int v = 0; v < 3; v++) {
    for (int k = 0; k < 40; k++) cyc[k] = (k + 1) * (K + (v - 1) * 3);
    detail::partials(gGrainSrc[1], cyc, 40, [](int k, double) { return 1.0 / (k + 1); }, v * 2.1);
  }
  // 2 glass: inharmonic partials, rounded to whole cycles, each shimmering at its own rate
  const double glass[8] = {1, 2.76, 5.40, 8.93, 13.34, 4.1, 6.8, 11.2};
  for (int k = 0; k < 8; k++) cyc[k] = static_cast<double>(static_cast<long>(K * glass[k] + 0.5));
  detail::partials(gGrainSrc[2], cyc, 8, [](int k, double t) { return (0.7 + 0.3 * sind(6.283185307179586 * t * (k + 1))) / (1 + k * 0.6); });
  // 3 breath: noise shaped by two formants, and a faint tone under it
  {
    Svf a, b;
    const float g1 = tanf_(PI * 900 / sr), g2 = tanf_(PI * 2500 / sr), k = 0.6f;
    const float a1 = 1 / (1 + g1 * (g1 + k)), b1 = 1 / (1 + g2 * (g2 + k));
    for (int i = 0; i < SLEN; i++) {
      const float n = rnd.bi();
      gGrainSrc[3][i] = a.run(n, a1, g1 * a1, g1 * g1 * a1, k, 1) + 0.6f * b.run(n, b1, g2 * b1, g2 * g2 * b1, k, 1);
    }
    cyc[0] = K; cyc[1] = 2 * K;
    detail::partials(gGrainSrc[3], cyc, 2, [](int k, double) { return k ? 0.02 : 0.05; });
  }
  // 4 bells: bell partials (hum, prime, tierce, quint, nominal...) swelling in turn
  const double bell[7] = {0.5, 1, 1.19, 1.5, 2, 2.51, 3.01};
  for (int k = 0; k < 7; k++) cyc[k] = static_cast<double>(static_cast<long>(K * bell[k] + 0.5));
  detail::partials(gGrainSrc[4], cyc, 7, [](int k, double t) { return (0.6 + 0.4 * cosd(6.283185307179586 * (t * 2 + k * 0.17))) / (1 + k * 0.3); });
  // 5 organ: 888000000 with a touch of 4'
  const double bars[4] = {0.5, 1.5, 1, 2};
  const double levels[4] = {1, 1, 1, 0.35};
  for (int k = 0; k < 4; k++) cyc[k] = K * bars[k];
  detail::partials(gGrainSrc[5], cyc, 4, [&](int k, double) { return levels[k]; });
  // 6 vowels: through a, e, i, o, u and back to a, one harmonic voice
  for (int k = 0; k < 30; k++) cyc[k] = (k + 1) * K;
  {
    const double F1[6] = {730, 530, 270, 570, 300, 730}, F2[6] = {1090, 1840, 2290, 840, 870, 1090};
    detail::partials(gGrainSrc[6], cyc, 30, [&](int k, double t) {
      const double at = t * 5; const int i = static_cast<int>(at); const double f = at - i, hz = (k + 1) * f0;
      const double a = F1[i] + (F1[i + 1] - F1[i]) * f, b = F2[i] + (F2[i + 1] - F2[i]) * f;
      return (detail::formant(hz, a, 110) + 0.7 * detail::formant(hz, b, 150)) / (1 + k * 0.05);
    });
  }
  // 7 metal: clanging partials, rounded to whole cycles
  const double metal[10] = {1, 1.41, 2.23, 2.87, 3.71, 4.54, 5.13, 6.27, 7.43, 8.66};
  for (int k = 0; k < 10; k++) cyc[k] = static_cast<double>(static_cast<long>(K * metal[k] + 0.5));
  detail::partials(gGrainSrc[7], cyc, 10, [](int k, double t) { return (0.8 + 0.2 * sind(6.283185307179586 * t * (3 + k))) / (1 + k * 0.25); }, 0.9);
  for (auto& src : gGrainSrc) {  // each peaks at 0.9
    float peak = 1e-9f;
    for (float x : src) peak = maxf(peak, fabsf_(x));
    for (float& x : src) x *= 0.9f / peak;
  }
  gGrainSrcRate = sr;
}

class Granular {
 public:
  static constexpr int COUNT = grain::NPARAMS;
  static constexpr bool SAMPLES = true;
  static const char* keys() { return grain::KEYS; }
  static const float* defaults() { return grain::DEFAULTS; }

  void init(float sampleRate) {
    buildTables();
    buildGrainSources(sampleRate);
    sr_ = sampleRate;
    for (int i = 0; i < grain::NPARAMS; i++) p_[i] = grain::DEFAULTS[i];
    for (auto& v : v_) v = Voice{};
    ctr_ = 0; dirty_ = true;
  }
  void set(int k, float value) { if (k >= 0 && k < grain::NPARAMS) { p_[k] = clampf(value, grain::MINS[k], grain::MAXS[k]); dirty_ = true; } }
  void tempo(float) {}
  // a sample of yours, mono at this sample rate; null for none. The caller keeps it alive while it's set.
  void sample(const float* data, int64_t frames) { user_ = frames > 0 ? data : nullptr; userLen_ = frames > 0 ? frames : 0; }

  void noteOn(int id, int note, float velocity) {
    if (dirty_) update();
    Voice* v = nullptr;
    for (auto& x : v_) if (!x.active && !v) v = &x;
    if (!v) for (int pass = 0; pass < 2 && !v; pass++)  // the oldest released voice, else the oldest
      for (auto& x : v_) if ((pass || !x.held) && (!v || x.age < v->age)) v = &x;
    if (!v->active) { for (auto& g : v->g) g.on = false; for (auto& f : v->f) f = Svf{}; v->amp.x = v->mod.x = 0; }
    v->id = id; v->note = note; v->vel = clampf(velocity, 0, 1); v->held = true; v->active = true; v->age = ++age_;
    v->scan = 0; v->next = 0; v->lfo = 0;
    v->amp.gate(true); v->mod.gate(true);
    controlVoice(*v);
  }
  void noteOff(int id) { for (auto& v : v_) if (v.active && v.held && v.id == id) release(v); }
  void releaseAll() { for (auto& v : v_) if (v.active && v.held) release(v); }
  void silence() { for (auto& v : v_) v.active = false; }
  bool sounding() const { for (const auto& v : v_) if (v.active) return true; return false; }

  void render(float* L, float* R, int n) {
    if (dirty_) update();
    while (n > 0) {
      if (ctr_ == 0) { for (auto& v : v_) if (v.active) controlVoice(v); ctr_ = grain::CTRL; }
      const int m = n < ctr_ ? n : ctr_;
      for (auto& v : v_) if (v.active) voice(v, L, R, m);
      L += m; R += m; n -= m; ctr_ -= m;
    }
  }

 private:
  struct Grain {
    bool on = false;
    double at = 0;  // where in the source, in frames
    float rate = 1, gl = 0, gr = 0;
    int len = 1, age = 0;
  };
  struct Voice {
    bool active = false, held = false;
    int id = 0, note = 60;
    float vel = 1, lfo = 0, next = 0;
    double scan = 0;  // how far the scan has moved, as a fraction of the source
    unsigned age = 0;
    Grain g[grain::GRAINS];
    Env amp, mod;
    Svf f[4];
    float a1 = 1, a2 = 0, a3 = 0, k = 2, rate = 1, sizeMul = 1, posMod = 0;
  };

  void release(Voice& v) { v.held = false; v.amp.gate(false); v.mod.gate(false); }
  void update() {
    using namespace grain;
    dirty_ = false;
    ampShape_.set(p_[P_aa], p_[P_ad], p_[P_as], p_[P_ar], sr_);
    modShape_.set(p_[P_ma], p_[P_md], p_[P_ms], p_[P_mr], sr_);
  }

  // the source playing now, and its length in frames
  const float* source(int64_t& len) const {
    const int s = clampi(static_cast<int>(p_[grain::P_source] + 0.5f), 0, grain::BUILT);
    if (s == grain::BUILT) { len = userLen_; return user_; }
    len = grain::SLEN; return gGrainSrc[s];
  }

  // once every CTRL frames: the LFO, the pitch, the filter
  void controlVoice(Voice& v) {
    using namespace grain;
    v.lfo += p_[P_lrate] * CTRL / sr_; v.lfo -= floorf_(v.lfo);
    const int shape = clampi(static_cast<int>(p_[P_lshape] + 0.5f), 0, 3);
    const float ph = v.lfo, l = shape == 0 ? readWave(0, LEVELS - 1, static_cast<uint32_t>(ph * 4294967040.f)) : shape == 1 ? 1 - 4 * fabsf_(ph - 0.5f) : shape == 2 ? 1 - 2 * ph : (ph < 0.5f ? 1.f : -1.f);
    v.posMod = l * p_[P_lpos] * 0.5f;
    v.sizeMul = exp2f_(l * p_[P_lsize] * 2);
    v.rate = exp2f_((static_cast<float>(v.note) - p_[P_root] + p_[P_pitch] + l * p_[P_lpitch] * 12) / 12);
    if (p_[P_ftype] >= 0.5f) {
      const float oct = p_[P_fenv] * 8 * v.mod.x + l * p_[P_lcut] * 4;
      const float fc = clampf(p_[P_cutoff] * exp2f_(oct), 20, sr_ * 0.45f), g = tanf_(PI * fc / sr_);
      v.k = 2 - 1.96f * p_[P_res]; v.a1 = 1 / (1 + g * (g + v.k)); v.a2 = g * v.a1; v.a3 = g * v.a2;
    }
  }

  // a new grain: where, how fast, which way, how loud on each side
  void spawn(Voice& v, int64_t len) {
    using namespace grain;
    Grain* g = nullptr;
    for (auto& x : v.g) if (!x.on) { g = &x; break; }
    if (!g) return;  // every slot in use: this one is skipped
    const float size = clampf(p_[P_size] * v.sizeMul, 2, 2000) * 0.001f;
    g->len = maxi(16, static_cast<int>(size * sr_));
    float semis = p_[P_prand] * p_[P_prand] * 12 * rand_.bi();
    if (rand_.uni() < p_[P_jump]) { const float r = rand_.uni(); semis += r < 0.4f ? 12 : r < 0.7f ? 7 : r < 0.9f ? -12 : 19; }
    g->rate = v.rate * exp2f_(semis / 12);
    if (rand_.uni() < p_[P_rev]) g->rate = -g->rate;
    double at = p_[P_pos] + v.posMod + v.scan + p_[P_spray] * rand_.bi() * 0.5;
    at -= floorf_(static_cast<float>(at));
    g->at = at * static_cast<double>(len);
    const float pan = p_[P_pan] * rand_.bi(), density = p_[P_density];
    const float gain = 1 / sqrtf_(maxf(1, density * size));  // overlapping grains add up by power
    g->gl = sqrtf_((1 - pan) * 0.5f) * 1.41421356f * gain; g->gr = sqrtf_((1 + pan) * 0.5f) * 1.41421356f * gain;
    g->age = 0; g->on = true;
  }
  static int maxi(int a, int b) { return a > b ? a : b; }

  void voice(Voice& v, float* L, float* R, int n) {
    using namespace grain;
    int64_t len = 0;
    const float* src = source(len);
    if (!src || len < 64) { for (int i = 0; i < n; i++) { v.amp.tick(ampShape_); v.mod.tick(modShape_); } if (v.amp.stage == Env::IDLE) v.active = false; return; }
    const float shape = 0.05f + 0.45f * p_[P_shape];  // how much of each end the window takes
    const float spacing = sr_ / p_[P_density], jitter = p_[P_jitter];
    const int ftype = clampi(static_cast<int>(p_[P_ftype] + 0.5f), 0, 5);
    const double scanStep = p_[P_scan] / static_cast<double>(len);  // 1: through the source at its own speed
    const bool wrap2 = (len & (len - 1)) == 0;
    for (int i = 0; i < n; i++) {
      if (--v.next <= 0) { spawn(v, len); v.next += spacing * (1 + jitter * rand_.bi() * 0.9f); }  // through the release too
      v.scan += scanStep; if (v.scan >= 1) v.scan -= 1; else if (v.scan < 0) v.scan += 1;
      float l = 0, r = 0;
      for (auto& g : v.g) {
        if (!g.on) continue;
        const float x = static_cast<float>(g.age) / g.len;
        const float edge = minf(x, 1 - x) / shape;  // the window: a raised sine over each end, flat between
        float w = 1;
        if (edge < 1) { const float s = readWave(0, LEVELS - 1, static_cast<uint32_t>(edge * 1073741824.f)); w = s * s; }
        int64_t i0 = static_cast<int64_t>(g.at);
        double fr = g.at - static_cast<double>(i0);
        if (g.at < 0) { i0 -= 1; fr += 1; }
        const int64_t a = wrap2 ? (i0 & (len - 1)) : ((i0 % len) + len) % len, b = wrap2 ? ((a + 1) & (len - 1)) : (a + 1 == len ? 0 : a + 1);
        const float s = (src[a] + (src[b] - src[a]) * static_cast<float>(fr)) * w;
        l += s * g.gl; r += s * g.gr;
        g.at += g.rate;
        if (++g.age >= g.len) g.on = false;
      }
      switch (ftype) {
        case F_LP12: l = v.f[0].run(l, v.a1, v.a2, v.a3, v.k, 0); r = v.f[1].run(r, v.a1, v.a2, v.a3, v.k, 0); break;
        case F_LP24:
          l = v.f[2].run(v.f[0].run(l, v.a1, v.a2, v.a3, v.k, 0), v.a1, v.a2, v.a3, v.k, 0);
          r = v.f[3].run(v.f[1].run(r, v.a1, v.a2, v.a3, v.k, 0), v.a1, v.a2, v.a3, v.k, 0);
          break;
        case F_HP12: l = v.f[0].run(l, v.a1, v.a2, v.a3, v.k, 2); r = v.f[1].run(r, v.a1, v.a2, v.a3, v.k, 2); break;
        case F_BP: l = v.f[0].run(l, v.a1, v.a2, v.a3, v.k, 1); r = v.f[1].run(r, v.a1, v.a2, v.a3, v.k, 1); break;
        case F_NOTCH: l = v.f[0].run(l, v.a1, v.a2, v.a3, v.k, 3); r = v.f[1].run(r, v.a1, v.a2, v.a3, v.k, 3); break;
        default: break;
      }
      const float a = v.amp.tick(ampShape_) * (1 - p_[P_vel] * (1 - v.vel)) * p_[P_level] * 4;  // windowed grains sit about 12 dB under full scale
      v.mod.tick(modShape_);
      L[i] += l * a; R[i] += r * a;
      if (v.amp.stage == Env::IDLE) { v.active = false; return; }
    }
  }

  float sr_ = 48000;
  float p_[grain::NPARAMS] = {};
  bool dirty_ = true;
  Voice v_[grain::MAXV];
  int ctr_ = 0;
  unsigned age_ = 0;
  EnvShape ampShape_, modShape_;
  const float* user_ = nullptr;
  int64_t userLen_ = 0;
  Rand rand_;
};

}  // namespace synth
