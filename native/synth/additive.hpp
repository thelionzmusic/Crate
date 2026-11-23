// Crate Additive: a tonewheel organ and a harmonic synth in one, both built from sines.
//
// The organ layer is a drawbar organ in the manner of the B3 (and NI's B4-II): nine drawbars at
// 16', 5⅓', 8', 4', 2⅔', 2', 1⅗', 1⅓' and 1', each step 3 dB; single-trigger percussion on the
// 2nd or 3rd harmonic (fast or slow, normal or soft; it takes the 1' drawbar, as on the real
// one); key click; the vibrato-chorus scanner (V1–V3, C1–C3); a tube drive; and a rotary speaker,
// a horn and a drum each turning at its own speed and taking its own time to change, heard by
// two microphones.
//
// The harmonic layer is up to 32 partials shaped by a tilt, an odd/even balance, a stretch that
// spreads them like a piano's or a bell's, and a formant; higher partials can die away faster,
// which is what makes a pluck or a bell sound real. It has its own envelope and velocity.
//
// No allocation and no C library, like fm.hpp: the same file builds into crate-engine and add.wasm.
#pragma once
#include "math.hpp"
#include "parts.hpp"
#include "wavetable.hpp"

namespace synth {

#define CRATE_ADD_PARAMS(X)                                                                                       \
  X(db1, 0, 8, 8) X(db2, 0, 8, 8) X(db3, 0, 8, 8) X(db4, 0, 8, 0) X(db5, 0, 8, 0) X(db6, 0, 8, 0)                  \
  X(db7, 0, 8, 0) X(db8, 0, 8, 0) X(db9, 0, 8, 0) X(organ, 0, 1, 1)                                               \
  X(perc, 0, 2, 0) X(pslow, 0, 1, 0) X(psoft, 0, 1, 0) X(click, 0, 1, 0.3) X(vib, 0, 6, 0)                         \
  X(harm, 0, 1, 0) X(parts, 1, 32, 16) X(tilt, -12, 6, -6) X(odd, -1, 1, 0) X(stretch, 0, 1, 0)                    \
  X(fpeak, 100, 8000, 1500) X(fgain, 0, 24, 0) X(fwidth, 0.2, 4, 1) X(damp, 0, 1, 0.3) X(spread, 0, 1, 0)          \
  X(hoct, -2, 2, 0) X(vel, 0, 1, 0.5)                                                                            \
  X(aa, 0, 10, 0.005) X(ad, 0, 10, 1) X(as, 0, 1, 1) X(ar, 0, 10, 0.3)                                            \
  X(lrate, 0.05, 12, 5) X(lvib, 0, 1, 0) X(ltrem, 0, 1, 0) X(ltilt, 0, 1, 0)                                      \
  X(rotary, 0, 1, 0) X(fast, 0, 1, 0) X(drive, 0, 1, 0) X(level, 0, 1, 0.27)

namespace add {
#define X(n, lo, hi, def) P_##n,
enum Param : int { CRATE_ADD_PARAMS(X) NPARAMS };
#undef X
#define X(n, lo, hi, def) #n "\0"
inline constexpr char KEYS[] = CRATE_ADD_PARAMS(X);
#undef X
#define X(n, lo, hi, def) static_cast<float>(def),
inline constexpr float DEFAULTS[NPARAMS] = {CRATE_ADD_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(lo),
inline constexpr float MINS[NPARAMS] = {CRATE_ADD_PARAMS(X)};
#undef X
#define X(n, lo, hi, def) static_cast<float>(hi),
inline constexpr float MAXS[NPARAMS] = {CRATE_ADD_PARAMS(X)};
#undef X

constexpr int MAXV = 16, BARS = 9, PARTS = 32, CTRL = 16;
constexpr float FOOT[BARS] = {0.5f, 1.5f, 1, 2, 3, 4, 5, 6, 8};  // each drawbar's harmonic of the 8' pitch
constexpr int DELAY = 2048;                                         // scanner and rotor delay lines, a power of two
}  // namespace add

class Additive {
 public:
  static constexpr bool SAMPLES = false;
  static constexpr int COUNT = add::NPARAMS;
  static const char* keys() { return add::KEYS; }
  static const float* defaults() { return add::DEFAULTS; }

  void init(float sampleRate) {
    buildTables();
    sr_ = sampleRate;
    for (int i = 0; i < add::NPARAMS; i++) p_[i] = add::DEFAULTS[i];
    for (auto& v : v_) v = Voice{};
    for (auto& d : dl_) for (auto& x : d) x = 0;
    held_ = 0; ctr_ = 0; dirty_ = true; perc_ = 0;
    hornSpeed_ = drumSpeed_ = -1;
  }
  void set(int k, float value) { if (k >= 0 && k < add::NPARAMS) { p_[k] = clampf(value, add::MINS[k], add::MAXS[k]); dirty_ = true; } }
  void tempo(float) {}

  void noteOn(int id, int note, float velocity) {
    if (dirty_) update();
    if (held_ == 0) perc_ = 1;  // single trigger: percussion strikes only on a key played with none held
    held_++;
    Voice* v = nullptr;
    for (auto& x : v_) if (!x.active && !v) v = &x;
    if (!v) for (int pass = 0; pass < 2 && !v; pass++)  // the oldest released voice, else the oldest
      for (auto& x : v_) if ((pass || !x.held) && (!v || x.age < v->age)) v = &x;
    const bool fresh = !v->active;
    v->id = id; v->note = note; v->vel = clampf(velocity, 0, 1); v->held = true; v->age = ++age_; v->active = true; v->t = 0;
    if (fresh) {
      for (auto& o : v->organ) o.start(0);
      v->perc.start(0);
      for (int k = 0; k < add::PARTS; k++) {  // with spread, partials start at random phases, as real ones do
        v->part[k].start(p_[add::P_spread] > 0 ? rand_.uni() * TAU : 0);
        v->partDet[k] = rand_.bi();
      }
      v->gate = v->amp.x = 0;
    }
    v->amp.gate(true);
    v->click = p_[add::P_click];
    v->tunedHz = -1;
    controlVoice(*v);
  }
  void noteOff(int id) {
    for (auto& v : v_) if (v.active && v.held && v.id == id) { release(v); if (held_ > 0) held_--; }
  }
  void releaseAll() { for (auto& v : v_) if (v.active && v.held) release(v); held_ = 0; }
  void silence() { for (auto& v : v_) v.active = false; held_ = 0; }
  bool sounding() const { for (const auto& v : v_) if (v.active) return true; return false; }

  void render(float* L, float* R, int n) {
    if (dirty_) update();
    while (n > 0) {
      if (ctr_ == 0) { control(); ctr_ = add::CTRL; }
      const int m = n < ctr_ ? n : ctr_;
      for (int i = 0; i < m; i++) bufL_[i] = bufR_[i] = organ_[i] = 0;
      for (auto& v : v_) if (v.active) voice(v, m);
      for (int i = 0; i < m; i++) perc_ *= percK_;
      if (perc_ < 1e-6f) perc_ = 0;
      post(L, R, m);
      L += m; R += m; n -= m; ctr_ -= m;
    }
  }

 private:
  struct Osc {
    float re = 1, im = 0, c = 1, s = 0;
    void start(float phase) { re = static_cast<float>(cosd(phase)); im = static_cast<float>(sind(phase)); }
    void tune(float hz, float sr) { const double w = 6.283185307179586 * hz / sr; c = static_cast<float>(cosd(w)); s = static_cast<float>(sind(w)); }
    void renorm() { const float m = re * re + im * im; const float k = 1.5f - 0.5f * m; re *= k; im *= k; }  // one Newton step back to 1
  };
  struct Voice {
    bool active = false, held = false;
    int id = 0, note = 60;
    float vel = 1, t = 0, gate = 0, click = 0, clickLp = 0;
    unsigned age = 0;
    // every sine is a phasor (re, im) turned by (c, s) each frame: four multiplies, no table
    Osc organ[add::BARS], perc, part[add::PARTS];
    float organAmp[add::BARS] = {}, partAmp[add::PARTS] = {}, partPan[add::PARTS] = {}, partDet[add::PARTS] = {};
    float tunedHz = -1;  // what its sines are tuned to, and the settings' version its spectrum came from
    unsigned built = 0;
    int parts = 0;
    Env amp;
  };

  void release(Voice& v) { v.held = false; v.amp.gate(false); }

  void update() {
    using namespace add;
    dirty_ = false;
    ampShape_.set(p_[P_aa], p_[P_ad], p_[P_as], p_[P_ar], sr_);
    percK_ = expf_(-6.9f / ((p_[P_pslow] >= 0.5f ? 1.0f : 0.2f) * sr_));  // to -60 dB in 0.2 s or 1 s
    gateUp_ = 1.f / (0.003f * sr_); gateDown_ = 1.f / (0.008f * sr_);     // key contacts: 3 ms on, 8 ms off
    xk_ = 1 - expf_(-TAU * 800 / sr_);                                       // the rotary's crossover
    for (int k = 0; k < PARTS; k++) dampK_[k] = expf_(-p_[P_damp] * 0.6f * (k + 1) * CTRL / sr_);  // each partial's fall per block
    version_++;
  }

  // once every CTRL frames: the LFO, the rotors, then every voice's partials
  void control() {
    using namespace add;
    lfo_ += p_[P_lrate] * CTRL / sr_; lfo_ -= floorf_(lfo_);
    scan_ += 6.9f * CTRL / sr_; scan_ -= floorf_(scan_);
    // the rotors drift to their speed: the horn quickly, the heavy drum slowly
    const bool fast = p_[P_fast] >= 0.5f;
    const float hornTo = fast ? 6.8f : 0.83f, drumTo = fast ? 5.9f : 0.67f;
    if (hornSpeed_ < 0) { hornSpeed_ = hornTo; drumSpeed_ = drumTo; }
    hornSpeed_ += (hornTo - hornSpeed_) * (1 - expf_(-CTRL / ((fast ? 0.7f : 1.6f) * sr_)));
    drumSpeed_ += (drumTo - drumSpeed_) * (1 - expf_(-CTRL / ((fast ? 4.5f : 5.5f) * sr_)));
    horn_ += hornSpeed_ * CTRL / sr_; horn_ -= floorf_(horn_);
    drum_ += drumSpeed_ * CTRL / sr_; drum_ -= floorf_(drum_);
    for (auto& v : v_) if (v.active) {
      v.t += CTRL / sr_; controlVoice(v);
      for (auto& o : v.organ) o.renorm();
      for (int k = 0; k < v.parts; k++) v.part[k].renorm();
      v.perc.renorm();
    }
  }

  // Retunes and reshapes only when the pitch or the settings changed (or the LFO moves the tilt);
  // otherwise each partial just falls by its damping
  void controlVoice(Voice& v) {
    using namespace add;
    const float lfo = readWave(0, LEVELS - 1, static_cast<uint32_t>(lfo_ * 4294967040.f));
    const float hz = noteHz(static_cast<float>(v.note) + lfo * p_[P_lvib] * 0.5f), nyq = sr_ * 0.45f;
    const bool retune = hz != v.tunedHz || v.built != version_, reshape = retune || p_[P_ltilt] > 0;
    if (!reshape) {  // flushed to zero once inaudible: decaying forever, they'd reach denormals, which are slow
      for (int k = 0; k < v.parts; k++) { v.partAmp[k] *= dampK_[k]; if (v.partAmp[k] < 1e-7f) v.partAmp[k] = 0; }
      return;
    }
    if (retune) {
      // organ: each drawbar 3 dB a step, nothing at 0; with percussion on, the 1' drawbar is taken
      const bool perc = p_[P_perc] >= 0.5f;
      for (int b = 0; b < BARS; b++) {
        const float pos = (perc && b == BARS - 1) ? 0 : p_[P_db1 + b], f = hz * FOOT[b];
        v.organAmp[b] = pos < 0.5f || f > nyq ? 0 : exp2f_((pos - 8) * 0.4983f) / 4;  // -3 dB a step; three full drawbars sit near full scale
        if (v.organAmp[b] > 0) v.organ[b].tune(f, sr_);
        v.organ[b].renorm();
      }
      v.perc.tune(hz * (p_[P_perc] >= 1.5f ? 3 : 2), sr_); v.perc.renorm();
    }
    // harmonic layer: tilt in dB an octave, odd against even, stretch, a formant, higher partials dying faster
    const float base = hz * exp2f_(p_[P_hoct]), B = p_[P_stretch] * p_[P_stretch] * 0.01f, damp = p_[P_damp] * 0.6f;
    const float tiltDb = p_[P_tilt] + lfo * p_[P_ltilt] * 6, oddv = p_[P_odd], spread = p_[P_spread];
    const int parts = clampi(static_cast<int>(p_[P_parts] + 0.5f), 1, PARTS);
    float norm = 0;
    v.parts = 0;
    for (int k = 0; k < parts; k++) {
      const float n = static_cast<float>(k + 1), f = base * n * sqrtf_(1 + B * n * n) * exp2f_(v.partDet[k] * spread * 8 / 1200);
      if (f > nyq) break;
      float a = exp2f_(tiltDb * log2f_(n) / 6.0206f);                         // dB per octave as a power of two
      if (k > 0) a *= (k & 1) ? 1 - maxf(0, oddv) : 1 - maxf(0, -oddv);       // k odd: an even harmonic
      const float x = log2f_(f / p_[P_fpeak]) / p_[P_fwidth];
      a *= exp2f_(p_[P_fgain] * expf_(-x * x) / 6.0206f);
      norm += a * a;
      v.partAmp[k] = a * expf_(-v.t * damp * n);
      if (v.partAmp[k] < 1e-7f) v.partAmp[k] = 0;
      if (retune) { v.part[k].tune(f, sr_); v.part[k].renorm(); }
      v.partPan[k] = spread * ((k & 1) ? 1.f : -1.f) * minf(1, n / 8);
      v.parts = k + 1;
    }
    const float g = (norm > 0 ? 1 / sqrtf_(norm) : 0) * (1 - p_[P_vel] * (1 - v.vel));  // by their power, so more partials aren't quieter
    for (int k = 0; k < v.parts; k++) v.partAmp[k] *= g;
    v.tunedHz = hz; v.built = version_;
  }

  // n <= CTRL frames of one voice: gate, click and envelopes first, then each sine across the
  // block with its phasor in registers
  void voice(Voice& v, int n) {
    using namespace add;
    const float organ = p_[P_organ], harm = p_[P_harm];
    const float trem = 1 - p_[P_ltrem] * 0.5f * (1 + readWave(0, LEVELS - 1, static_cast<uint32_t>(lfo_ * 4294967040.f)));
    const float percLevel = p_[P_perc] >= 0.5f ? (p_[P_psoft] >= 0.5f ? 0.35f : 0.7f) : 0;
    float gate[CTRL], amp[CTRL], percEnv[CTRL];
    int end = n;
    float pe = perc_;
    for (int i = 0; i < n; i++) {
      if (pe < 1e-6f) pe = 0;
      v.gate = v.held ? minf(1, v.gate + gateUp_) : maxf(0, v.gate - gateDown_);
      gate[i] = v.gate * organ; amp[i] = v.amp.tick(ampShape_) * harm * trem; percEnv[i] = pe * percLevel; pe *= percK_;
      // the key click: a short burst of bright noise as the contacts close
      if (v.click > 1e-4f) { const float x = rand_.bi(); v.clickLp += (x - v.clickLp) * 0.35f; organ_[i] += (x - v.clickLp) * v.click * 0.25f * organ; v.click *= 0.992f; }
      if (!v.held && v.gate <= 0 && v.amp.stage == Env::IDLE && v.click <= 1e-4f) { end = i + 1; v.active = false; break; }
    }
    if (organ > 0 && v.gate + gate[0] > 0) {
      for (int b = 0; b < BARS; b++) {
        Osc o = v.organ[b];
        const float g = v.organAmp[b];
        if (g > 0) for (int i = 0; i < end; i++) { const float re = o.re * o.c - o.im * o.s; o.im = o.re * o.s + o.im * o.c; o.re = re; organ_[i] += o.im * g * gate[i]; }
        else for (int i = 0; i < end; i++) { const float re = o.re * o.c - o.im * o.s; o.im = o.re * o.s + o.im * o.c; o.re = re; }
        v.organ[b] = o;
      }
      if (percEnv[0] > 0) {
        Osc o = v.perc;
        for (int i = 0; i < end; i++) { const float re = o.re * o.c - o.im * o.s; o.im = o.re * o.s + o.im * o.c; o.re = re; organ_[i] += o.im * percEnv[i] * gate[i]; }
        v.perc = o;
      }
    }
    if (harm > 0 && v.amp.x + amp[0] > 0) {
      for (int k = 0; k < v.parts; k++) {
        if (v.partAmp[k] == 0) continue;
        Osc o = v.part[k];
        const float gl = v.partAmp[k] * (1 - v.partPan[k]), gr = v.partAmp[k] * (1 + v.partPan[k]);
        for (int i = 0; i < end; i++) { const float re = o.re * o.c - o.im * o.s; o.im = o.re * o.s + o.im * o.c; o.re = re; const float x = o.im * amp[i]; bufL_[i] += x * gl; bufR_[i] += x * gr; }
        v.part[k] = o;
      }
    }
  }

  // the organ through the scanner and drive, then everything through the rotary speaker
  void post(float* L, float* R, int n) {
    using namespace add;
    const int vib = clampi(static_cast<int>(p_[P_vib] + 0.5f), 0, 6);
    const float depthMs = vib ? (0.12f + 0.115f * ((vib - 1) % 3)) : 0, chorus = vib >= 4 ? 0.5f : 0;
    const float drive = p_[P_drive], pre = 1 + drive * 12, post = 1 / tanhf_(pre * 0.6f + 0.2f) * 0.7f;
    const bool rotary = p_[P_rotary] >= 0.5f;
    const float gain = p_[P_level];
    for (int i = 0; i < n; i++) {
      float o = organ_[i];
      if (vib) {  // the scanner: a delay swept at 6.9 Hz; the chorus settings mix it with the dry
        write(0, o);
        const float d = (1.f + depthMs * (1 + readWave(0, LEVELS - 1, static_cast<uint32_t>(scan_ * 4294967040.f)))) * sr_ / 1000;
        o = o * chorus + tap(0, d) * (1 - chorus);
      }
      if (drive > 0) o = (tanhf_(o * pre + 0.2f) - 0.19738f) * post;  // a tube's lean to one side
      float l = o + bufL_[i], r = o + bufR_[i];
      if (rotary) {  // a crossover at 800 Hz; the horn takes the top, the drum the bottom
        const float m = (l + r) * 0.5f;
        lp1_ += (m - lp1_) * xk_; lp2_ += (lp1_ - lp2_) * xk_;
        const float lo = lp2_, hi = m - lo;
        write(1, hi); write(2, lo);
        const float hs = readWave(0, LEVELS - 1, static_cast<uint32_t>(horn_ * 4294967040.f)), hc = readWave(0, LEVELS - 1, static_cast<uint32_t>(horn_ * 4294967040.f) + 0x40000000u);
        const float ds = readWave(0, LEVELS - 1, static_cast<uint32_t>(drum_ * 4294967040.f)), dc = readWave(0, LEVELS - 1, static_cast<uint32_t>(drum_ * 4294967040.f) + 0x40000000u);
        const float ms = sr_ / 1000;
        // each microphone hears the rotor come and go (level) and move (pitch, through the delay)
        const float hl = tap(1, (1.0f + 0.35f * hs) * ms) * (1 + 0.45f * hc), hr = tap(1, (1.0f - 0.35f * hc) * ms) * (1 + 0.45f * hs);
        const float dl = tap(2, (1.0f + 0.25f * ds) * ms) * (1 + 0.25f * dc), dr = tap(2, (1.0f - 0.25f * dc) * ms) * (1 + 0.25f * ds);
        l = (hl + dl) * 0.8f; r = (hr + dr) * 0.8f;
      }
      L[i] += l * gain; R[i] += r * gain;
      w_ = (w_ + 1) & (add::DELAY - 1);
    }
  }
  void write(int line, float x) { dl_[line][w_] = x; }
  float tap(int line, float samples) {
    const float pos = static_cast<float>(w_) - samples;
    const float fl = floorf_(pos), f = pos - fl;
    const int i = static_cast<int>(fl) & (add::DELAY - 1);
    const float* d = dl_[line];
    return d[i] + (d[(i + 1) & (add::DELAY - 1)] - d[i]) * f;
  }

  float sr_ = 48000;
  float p_[add::NPARAMS] = {};
  bool dirty_ = true;
  Voice v_[add::MAXV];
  int held_ = 0, ctr_ = 0;
  unsigned age_ = 0;
  EnvShape ampShape_;
  float perc_ = 0, percK_ = 0.999f, gateUp_ = 0.01f, gateDown_ = 0.01f;
  float lfo_ = 0, scan_ = 0, horn_ = 0, drum_ = 0.3f, hornSpeed_ = -1, drumSpeed_ = -1;
  float lp1_ = 0, lp2_ = 0, xk_ = 0.1f, dampK_[add::PARTS] = {};
  unsigned version_ = 1;
  float dl_[3][add::DELAY] = {};
  int w_ = 0;
  Rand rand_;
  float bufL_[add::CTRL], bufR_[add::CTRL], organ_[add::CTRL];
};

}  // namespace synth
