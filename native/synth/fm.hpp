// Crate FM: four operators in the manner of Logic's Retro Synth FM and Serum's oscillators.
// Each operator reads a band-limited wavetable whose position morphs sine → triangle → saw →
// square → pulse → vowel, at a ratio of the note, with its own envelope, velocity response
// and feedback. Eight algorithms route operators into one another (phase modulation, as in
// the DX7) or straight out. Then unison (up to 7 detuned, spread copies of every operator),
// a sub and noise, a drivable state-variable filter with its own envelope, an amp envelope,
// two LFOs (free or synced, per note or shared) and a six-slot modulation matrix.
//
// No allocation and no C library: one instance is plain memory, rendered in place. The same
// file builds into crate-engine and into fm.wasm for the browser engine.
#pragma once
#include "math.hpp"
#include "parts.hpp"
#include "wavetable.hpp"

namespace synth {

// every parameter: name, range, default. The page's devices.js lists the same, in this order.
#define CRATE_FM_OP(X, o, R0, L0)                                                                         \
  X(o##wave, 0, 5, 0) X(o##ratio, 0.5, 16, R0) X(o##fine, -100, 100, 0) X(o##level, 0, 1, L0)            \
  X(o##fb, 0, 1, 0) X(o##att, 0, 10, 0.002) X(o##dec, 0, 10, 1) X(o##sus, 0, 1, 1) X(o##rel, 0, 10, 0.3) X(o##vel, 0, 1, 0)
#define CRATE_FM_SLOT(X, i) X(m##i##src, 0, 7, 0) X(m##i##dst, 0, 11, 0) X(m##i##amt, -1, 1, 0)
#define CRATE_FM_PARAMS(X)                                                                                       \
  CRATE_FM_OP(X, a, 1, 0.8) CRATE_FM_OP(X, b, 1, 0.35) CRATE_FM_OP(X, c, 2, 0) CRATE_FM_OP(X, d, 3, 0)          \
  X(algo, 0, 7, 0) X(fm, 0, 1, 0.5) X(sub, 0, 1, 0) X(noise, 0, 1, 0)                                            \
  X(oct, -3, 3, 0) X(semi, -12, 12, 0) X(uni, 1, 7, 1) X(detune, 0, 1, 0.25) X(spread, 0, 1, 0.5)               \
  X(glide, 0, 2, 0) X(mono, 0, 2, 0) X(vel, 0, 1, 0.6)                                                           \
  X(ftype, 0, 5, 0) X(cutoff, 20, 20000, 20000) X(res, 0, 1, 0.1) X(drive, 0, 1, 0) X(fenv, -1, 1, 0)           \
  X(fkey, 0, 1, 0) X(fvel, 0, 1, 0)                                                                              \
  X(aa, 0, 10, 0.002) X(ad, 0, 10, 0.3) X(as, 0, 1, 1) X(ar, 0, 10, 0.25)                                        \
  X(ma, 0, 10, 0.002) X(md, 0, 10, 0.4) X(ms, 0, 1, 0) X(mr, 0, 10, 0.3)                                         \
  X(l1shape, 0, 5, 0) X(l1rate, 0.05, 30, 2) X(l1sync, 0, 1, 0) X(l1div, 0, 11, 7) X(l1trig, 0, 1, 1)           \
  X(l2shape, 0, 5, 0) X(l2rate, 0.05, 30, 0.5) X(l2sync, 0, 1, 0) X(l2div, 0, 11, 5) X(l2trig, 0, 1, 0)         \
  CRATE_FM_SLOT(X, 1) CRATE_FM_SLOT(X, 2) CRATE_FM_SLOT(X, 3) CRATE_FM_SLOT(X, 4) CRATE_FM_SLOT(X, 5)            \
  CRATE_FM_SLOT(X, 6) X(macro, 0, 1, 0) X(dist, 0, 1, 0) X(level, 0, 1, 0.7)

namespace fm {
#define X(n, lo, hi, def) P_##n,
enum Param : int { CRATE_FM_PARAMS(X) NPARAMS };
#undef X
#define X(n, lo, hi, def) #n "\0"
inline constexpr char KEYS[] = CRATE_FM_PARAMS(X);  // the names, each ended by a zero
#undef X
#define X(n, lo, hi, def) static_cast<float>(def),
inline constexpr float DEFAULTS[NPARAMS] = {CRATE_FM_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(lo),
inline constexpr float MINS[NPARAMS] = {CRATE_FM_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(hi),
inline constexpr float MAXS[NPARAMS] = {CRATE_FM_PARAMS(X)};
#undef X

constexpr int OPS = 4, OPP = P_bwave - P_awave, MAXV = 16, MAXUNI = 7, BUDGET = 64, CTRL = 16, SLOTS = 6;
constexpr float MAXMOD = 8.f;  // radians of phase modulation at full level and full FM
// LFO divisions in beats: 4 bars … 1/32, triplets between
constexpr float DIVS[12] = {16, 8, 4, 2, 4.f / 3, 1, 2.f / 3, 0.5f, 1.f / 3, 0.25f, 1.f / 6, 0.125f};
// for each algorithm: which operators modulate each one (bit i = operator i), and which are heard
constexpr uint8_t MODS[8][OPS] = {{2, 4, 8, 0}, {6, 0, 8, 0}, {14, 0, 0, 0}, {2, 0, 8, 0}, {8, 8, 8, 0}, {0, 4, 8, 0}, {2, 0, 0, 0}, {0, 0, 0, 0}};
constexpr uint8_t OUTS[8] = {1, 1, 1, 5, 7, 3, 13, 15};
enum Src { S_OFF, S_LFO1, S_LFO2, S_MODENV, S_VEL, S_MACRO, S_KEY, S_RANDOM };
enum Dst { D_PITCH, D_CUTOFF, D_RES, D_FM, D_A, D_B, D_C, D_D, D_WAVE, D_PAN, D_AMP, D_DETUNE, NDST };
enum FType { F_OFF, F_LP12, F_LP24, F_HP12, F_BP, F_NOTCH };
}  // namespace fm

class Fm {
 public:
  // what the native device wrapper and the wasm glue need to know about any synth
  static constexpr int COUNT = fm::NPARAMS;
  static const char* keys() { return fm::KEYS; }
  static const float* defaults() { return fm::DEFAULTS; }

  void init(float sampleRate) {
    buildTables();
    sr_ = sampleRate;
    for (int i = 0; i < fm::NPARAMS; i++) p_[i] = fm::DEFAULTS[i];
    for (auto& v : v_) v = Voice{};
    held_ = 0; ctr_ = 0; dirty_ = true;
  }
  void set(int k, float value) { if (k >= 0 && k < fm::NPARAMS) { p_[k] = clampf(value, fm::MINS[k], fm::MAXS[k]); dirty_ = true; } }
  float get(int k) const { return k >= 0 && k < fm::NPARAMS ? p_[k] : 0; }
  void tempo(float bpm) { if (bpm > 0) bpm_ = bpm; }

  void noteOn(int id, int note, float velocity) {
    if (dirty_) update();
    velocity = clampf(velocity, 0, 1);
    if (mono_) {
      if (held_ == fm::MAXV) remove(0);
      stack_[held_++] = {id, note, velocity};
      Voice& v = v_[0];
      const bool legato = mono_ == 2 && v.active && held_ > 1;
      v.id = id;
      glideTo(v, note, !v.active);
      if (!legato) start(v, note, velocity);
      return;
    }
    Voice* v = nullptr;
    for (int i = 0; i < limit_ && !v; i++) if (!v_[i].active) v = &v_[i];
    if (!v) {  // the oldest released voice, else the oldest
      for (int pass = 0; pass < 2 && !v; pass++)
        for (int i = 0; i < limit_; i++) if ((pass || !v_[i].held) && (!v || v_[i].age < v->age)) v = &v_[i];
    }
    v->id = id;
    glideTo(*v, note, !v->active);
    start(*v, note, velocity);
  }
  void noteOff(int id) {
    if (mono_) {
      for (int i = 0; i < held_; i++) if (stack_[i].id == id) { remove(i); break; }
      Voice& v = v_[0];
      if (held_ && v.id == id) { const Held& h = stack_[held_ - 1]; v.id = h.id; glideTo(v, h.note, false); }  // back to the note still held
      else if (!held_ && v.active) release(v);
      return;
    }
    for (auto& v : v_) if (v.active && v.held && v.id == id) release(v);
  }
  void releaseAll() { held_ = 0; for (auto& v : v_) if (v.active) release(v); }
  void silence() { held_ = 0; for (auto& v : v_) v.active = false; }
  bool sounding() const { for (const auto& v : v_) if (v.active) return true; return false; }

  // add n frames into L and R
  void render(float* L, float* R, int n) {
    if (dirty_) update();
    while (n > 0) {
      if (ctr_ == 0) { control(); ctr_ = fm::CTRL; }
      const int m = n < ctr_ ? n : ctr_;
      for (int i = 0; i < m; i++) bufL_[i] = bufR_[i] = 0;
      for (auto& v : v_) if (v.active) voice(v, m);
      const float dist = p_[fm::P_dist], gain = p_[fm::P_level];
      if (dist > 0) {
        const float pre = 1 + dist * 15, post = gain / tanhf_(pre * 0.5f) * 0.5f;
        for (int i = 0; i < m; i++) { L[i] += tanhf_(bufL_[i] * pre) * post; R[i] += tanhf_(bufR_[i] * pre) * post; }
      } else {
        for (int i = 0; i < m; i++) { L[i] += bufL_[i] * gain; R[i] += bufR_[i] * gain; }
      }
      L += m; R += m; n -= m; ctr_ -= m;
    }
  }

 private:
  struct Held { int id, note; float vel; };
  struct Voice {
    bool active = false, held = false;
    int id = 0, note = 60;
    float vel = 1, rnd = 0;
    unsigned age = 0;
    float pitch = 60, target = 60;
    uint32_t ph[fm::OPS][fm::MAXUNI] = {}, inc[fm::OPS][fm::MAXUNI] = {}, subPh = 0, subInc = 0;
    float fb[fm::OPS][fm::MAXUNI][2] = {};
    int level[fm::OPS] = {};
    float gain[fm::OPS] = {}, gL[fm::MAXUNI] = {}, gR[fm::MAXUNI] = {};
    float depth = 0, wave[fm::OPS] = {}, amp = 1;
    Env env[fm::OPS], ampEnv, modEnv;
    float lfoPh[2] = {}, lfoHold[2] = {};
    Svf f[4];
    float a1 = 1, a2 = 0, a3 = 0, k = 2;
  };

  void remove(int i) { for (; i < held_ - 1; i++) stack_[i] = stack_[i + 1]; held_--; }
  void glideTo(Voice& v, int note, bool fresh) {
    v.note = note; v.target = static_cast<float>(note);
    if (fresh) v.pitch = p_[fm::P_glide] > 0 && last_ >= 0 ? static_cast<float>(last_) : v.target;
    last_ = note;
  }
  void start(Voice& v, int note, float velocity) {
    v.note = note; v.vel = velocity; v.held = true; v.age = ++age_;
    v.rnd = rand_.bi();
    if (!v.active) {  // a fresh voice starts from silence, its oscillators at zero phase
      for (auto& row : v.ph) for (auto& p : row) p = 0;
      for (auto& row : v.fb) for (auto& p : row) p[0] = p[1] = 0;
      for (auto& f : v.f) f = Svf{};
      v.subPh = 0;
      for (auto& e : v.env) e.x = 0;
      v.ampEnv.x = v.modEnv.x = 0;
    }
    for (int l = 0; l < 2; l++) {
      if (lfoTrig_[l]) { v.lfoPh[l] = 0; v.lfoHold[l] = rand_.bi(); } else { v.lfoPh[l] = shared_[l]; v.lfoHold[l] = sharedHold_[l]; }
    }
    v.active = true;
    for (auto& e : v.env) e.gate(true);
    v.ampEnv.gate(true); v.modEnv.gate(true);
    controlVoice(v);
  }
  void release(Voice& v) {
    v.held = false;
    for (auto& e : v.env) e.gate(false);
    v.ampEnv.gate(false); v.modEnv.gate(false);
  }

  // parameters to the numbers the voices use
  void update() {
    dirty_ = false;
    using namespace fm;
    for (int o = 0; o < OPS; o++) {
      const float* q = p_ + P_awave + o * OPP;
      opEnv_[o].set(q[P_aatt - P_awave], q[P_adec - P_awave], q[P_asus - P_awave], q[P_arel - P_awave], sr_);
      opMul_[o] = q[P_aratio - P_awave] * exp2f_(q[P_afine - P_awave] / 1200);
    }
    ampShape_.set(p_[P_aa], p_[P_ad], p_[P_as], p_[P_ar], sr_);
    modShape_.set(p_[P_ma], p_[P_md], p_[P_ms], p_[P_mr], sr_);
    algo_ = clampi(static_cast<int>(p_[P_algo] + 0.5f), 0, 7);
    uni_ = clampi(static_cast<int>(p_[P_uni] + 0.5f), 1, MAXUNI);
    limit_ = clampi(BUDGET / uni_, 1, MAXV);
    const int mono = clampi(static_cast<int>(p_[P_mono] + 0.5f), 0, 2);
    if (mono != mono_) { silence(); mono_ = mono; }
    lfoTrig_[0] = p_[P_l1trig] >= 0.5f; lfoTrig_[1] = p_[P_l2trig] >= 0.5f;
  }

  float lfoRate(int l) const {
    const float* q = p_ + (l ? fm::P_l2shape : fm::P_l1shape);
    return q[2] >= 0.5f ? bpm_ / 60 / fm::DIVS[clampi(static_cast<int>(q[3] + 0.5f), 0, 11)] : q[1];
  }
  static float lfoShape(int shape, float ph, float hold) {
    switch (shape) {
      case 0: return readWave(0, LEVELS - 1, static_cast<uint32_t>(ph * 4294967040.f));
      case 1: return 1 - 4 * fabsf_(ph - 0.5f);
      case 2: return 1 - 2 * ph;
      case 3: return 2 * ph - 1;
      case 4: return ph < 0.5f ? 1.f : -1.f;
      default: return hold;
    }
  }

  // once every CTRL frames: the LFOs move, and every voice's pitch, levels and filter follow
  void control() {
    for (int l = 0; l < 2; l++) {
      shared_[l] += lfoRate(l) * fm::CTRL / sr_;
      if (shared_[l] >= 1) { shared_[l] -= floorf_(shared_[l]); sharedHold_[l] = rand_.bi(); }
    }
    for (auto& v : v_) if (v.active) {
      for (int l = 0; l < 2; l++) {
        v.lfoPh[l] += lfoRate(l) * fm::CTRL / sr_;
        if (v.lfoPh[l] >= 1) { v.lfoPh[l] -= floorf_(v.lfoPh[l]); v.lfoHold[l] = lfoTrig_[l] ? rand_.bi() : sharedHold_[l]; }
      }
      const float g = p_[fm::P_glide];
      v.pitch = g > 0 ? v.target + (v.pitch - v.target) * expf_(-3.f * fm::CTRL / (g * sr_)) : v.target;
      controlVoice(v);
    }
  }

  void controlVoice(Voice& v) {
    using namespace fm;
    // the modulation matrix
    float d[NDST] = {};
    const float src[8] = {0, lfoShape(clampi(static_cast<int>(p_[P_l1shape] + 0.5f), 0, 5), v.lfoPh[0], v.lfoHold[0]),
                          lfoShape(clampi(static_cast<int>(p_[P_l2shape] + 0.5f), 0, 5), v.lfoPh[1], v.lfoHold[1]),
                          v.modEnv.x, v.vel, p_[P_macro], (static_cast<float>(v.note) - 60) / 24, v.rnd};
    for (int s = 0; s < SLOTS; s++) {
      const float* q = p_ + P_m1src + s * 3;
      const int from = clampi(static_cast<int>(q[0] + 0.5f), 0, 7), to = clampi(static_cast<int>(q[1] + 0.5f), 0, NDST - 1);
      if (from) d[to] += src[from] * q[2];
    }
    const float pitch = v.pitch + p_[P_oct] * 12 + p_[P_semi] + d[D_PITCH] * 24, hz = noteHz(pitch), toInc = 4294967296.f / sr_;
    // unison: copies spread evenly across the detune and the stereo field
    const float det = clampf(p_[P_detune] + d[D_DETUNE], 0, 1), cents = det * det * 100, spread = p_[P_spread];
    const float norm = 1 / sqrtf_(static_cast<float>(uni_)), pan = clampf(d[D_PAN], -1, 1);
    float mul[MAXUNI];
    for (int u = 0; u < uni_; u++) {
      const float pos = uni_ == 1 ? 0 : 2.f * u / (uni_ - 1) - 1, x = clampf(pos * spread + pan, -1, 1);
      mul[u] = uni_ == 1 ? 1 : exp2f_(pos * cents / 1200);
      v.gL[u] = sqrtf_((1 - x) * 0.5f) * norm * 1.41421356f; v.gR[u] = sqrtf_((1 + x) * 0.5f) * norm * 1.41421356f;
    }
    for (int o = 0; o < OPS; o++) {
      const float* q = p_ + P_awave + o * OPP;
      const float base = hz * opMul_[o] * toInc;
      for (int u = 0; u < uni_; u++) v.inc[o][u] = static_cast<uint32_t>(minf(base * mul[u], 2147483000.f));
      v.level[o] = levelFor(v.inc[o][0]);
      v.gain[o] = clampf(q[P_alevel - P_awave] + d[D_A + o], 0, 1) * (1 - q[P_avel - P_awave] * (1 - v.vel));
      v.wave[o] = clampf(q[0] + d[D_WAVE] * 5, 0, SHAPES - 1);
    }
    v.subInc = static_cast<uint32_t>(hz * 0.5f * toInc);
    v.depth = clampf(p_[P_fm] + d[D_FM], 0, 2) * MAXMOD;
    v.amp = maxf(0, 1 + d[D_AMP]) * (1 - p_[P_vel] * (1 - v.vel));
    // the filter's cutoff, by its envelope, the matrix, the key and velocity
    if (p_[P_ftype] >= 0.5f) {
      const float oct = p_[P_fenv] * 8 * v.modEnv.x + d[D_CUTOFF] * 8 + p_[P_fkey] * (static_cast<float>(v.note) - 60) / 12 + p_[P_fvel] * v.vel * 4;
      const float fc = clampf(p_[P_cutoff] * exp2f_(oct), 20, sr_ * 0.45f), g = tanf_(PI * fc / sr_);
      v.k = 2 - 1.96f * clampf(p_[P_res] + d[D_RES], 0, 1);
      v.a1 = 1 / (1 + g * (g + v.k)); v.a2 = g * v.a1; v.a3 = g * v.a2;
    }
  }

  // n <= CTRL frames of one voice: envelopes first, then each unison copy through the whole
  // block with its operators' state held in locals, then sub, noise, drive, filter and amp
  void voice(Voice& v, int n) {
    using namespace fm;
    const uint8_t* mods = MODS[algo_];
    const uint8_t outs = OUTS[algo_];
    float env[OPS][CTRL], amp[CTRL];
    bool live[OPS];
    for (int o = 0; o < OPS; o++) {
      float peak = 0;
      for (int i = 0; i < n; i++) { env[o][i] = v.env[o].tick(opEnv_[o]) * v.gain[o]; peak = maxf(peak, env[o][i]); }
      live[o] = peak > 0;
    }
    int end = n;
    for (int i = 0; i < n; i++) {
      amp[i] = v.ampEnv.tick(ampShape_) * v.amp;
      v.modEnv.tick(modShape_);
      if (v.ampEnv.stage == Env::IDLE) { end = i + 1; v.active = false; break; }
    }
    // each operator's tables for this block, morphing between two neighbouring shapes
    const float* ta[OPS];
    const float* tb[OPS];
    float morph[OPS], fbk[OPS];
    for (int o = 0; o < OPS; o++) {
      const int s0 = static_cast<int>(v.wave[o]), s1 = s0 + 1 < SHAPES ? s0 + 1 : s0;
      ta[o] = gTables[s0][v.level[o]]; tb[o] = gTables[s1][v.level[o]];
      morph[o] = v.wave[o] - static_cast<float>(s0);
      fbk[o] = p_[P_afb + o * OPP] * PI * 0.5f;
    }
    float l[CTRL] = {}, r[CTRL] = {};
    constexpr float RAD = 4294967296.f / TAU;  // radians to a 32-bit phase
    for (int u = 0; u < uni_; u++) {
      uint32_t ph[OPS], inc[OPS];
      float z1[OPS], z2[OPS];
      for (int o = 0; o < OPS; o++) { ph[o] = v.ph[o][u]; inc[o] = v.inc[o][u]; z1[o] = v.fb[o][u][0]; z2[o] = v.fb[o][u][1]; }
      const float gl = v.gL[u], gr = v.gR[u];
      for (int i = 0; i < end; i++) {
        float out[OPS] = {};
        for (int o = OPS - 1; o >= 0; o--) {  // modulators always sit above what they modulate
          if (!live[o]) continue;
          uint32_t at = ph[o];
          if (mods[o] | (fbk[o] > 0)) {
            float pm = fbk[o] * (z1[o] + z2[o]);
            for (int m = o + 1; m < OPS; m++) if (mods[o] & (1 << m)) pm += out[m] * v.depth;
            at += static_cast<uint32_t>(static_cast<int64_t>(clampf(pm, -1000.f, 1000.f) * RAD));
          }
          const uint32_t k = at >> (32 - TBITS);
          const float f = static_cast<float>(at & ((1u << (32 - TBITS)) - 1)) * (1.f / (1u << (32 - TBITS)));
          float x = ta[o][k] + (ta[o][k + 1] - ta[o][k]) * f;
          if (morph[o] > 0) x += (tb[o][k] + (tb[o][k + 1] - tb[o][k]) * f - x) * morph[o];
          z2[o] = z1[o]; z1[o] = x;
          out[o] = x * env[o][i];
          ph[o] += inc[o];
        }
        float c = 0;
        for (int o = 0; o < OPS; o++) if (outs & (1 << o)) c += out[o];
        l[i] += c * gl; r[i] += c * gr;
      }
      for (int o = 0; o < OPS; o++) {
        if (!live[o]) ph[o] += inc[o] * static_cast<uint32_t>(end);
        v.ph[o][u] = ph[o]; v.fb[o][u][0] = z1[o]; v.fb[o][u][1] = z2[o];
      }
    }
    const int ftype = clampi(static_cast<int>(p_[P_ftype] + 0.5f), 0, 5);
    const float sub = p_[P_sub] * 0.7f, noise = p_[P_noise] * 0.5f, drive = p_[P_drive];
    const float pre = 1 + drive * 7, post = 1 / (1 + drive * 2);
    for (int i = 0; i < end; i++) {
      float x = l[i], y = r[i];
      if (sub > 0) { const float s = readWave(0, LEVELS - 1, v.subPh) * sub; x += s; y += s; }
      v.subPh += v.subInc;
      if (noise > 0) { x += rand_.bi() * noise; y += rand_.bi() * noise; }
      if (drive > 0) { x = softclip(x * pre) * post; y = softclip(y * pre) * post; }
      switch (ftype) {
        case F_LP12: x = v.f[0].run(x, v.a1, v.a2, v.a3, v.k, 0); y = v.f[1].run(y, v.a1, v.a2, v.a3, v.k, 0); break;
        case F_LP24:
          x = v.f[2].run(v.f[0].run(x, v.a1, v.a2, v.a3, v.k, 0), v.a1, v.a2, v.a3, v.k, 0);
          y = v.f[3].run(v.f[1].run(y, v.a1, v.a2, v.a3, v.k, 0), v.a1, v.a2, v.a3, v.k, 0);
          break;
        case F_HP12: x = v.f[0].run(x, v.a1, v.a2, v.a3, v.k, 2); y = v.f[1].run(y, v.a1, v.a2, v.a3, v.k, 2); break;
        case F_BP: x = v.f[0].run(x, v.a1, v.a2, v.a3, v.k, 1); y = v.f[1].run(y, v.a1, v.a2, v.a3, v.k, 1); break;
        case F_NOTCH: x = v.f[0].run(x, v.a1, v.a2, v.a3, v.k, 3); y = v.f[1].run(y, v.a1, v.a2, v.a3, v.k, 3); break;
        default: break;
      }
      bufL_[i] += x * amp[i]; bufR_[i] += y * amp[i];
    }
  }

  float sr_ = 48000, bpm_ = 120;
  float p_[fm::NPARAMS] = {};
  bool dirty_ = true;
  Voice v_[fm::MAXV];
  Held stack_[fm::MAXV] = {};
  int held_ = 0, last_ = -1, mono_ = 0, algo_ = 0, uni_ = 1, limit_ = fm::MAXV, ctr_ = 0;
  unsigned age_ = 0;
  EnvShape opEnv_[fm::OPS], ampShape_, modShape_;
  float opMul_[fm::OPS] = {1, 1, 2, 3};
  bool lfoTrig_[2] = {true, false};
  float shared_[2] = {}, sharedHold_[2] = {};
  Rand rand_;
  float bufL_[fm::CTRL], bufR_[fm::CTRL];
};

}  // namespace synth
