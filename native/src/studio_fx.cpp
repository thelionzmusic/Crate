// Production's built-in effects, native. Same parameters, defaults and curves as the page's
// devices.js; where the web version leans on a browser node (convolution reverb, oversampled
// shaper), this one does the job properly in its own way: an 8-line feedback delay network for
// the reverb, and antiderivative anti-aliasing for the shaping curves.
#include "studio_fx.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <functional>
#include <utility>

#include "dsp.hpp"

namespace crate {
namespace {

constexpr int SUB = 16;  // a modulated filter recomputes its coefficients this often (frames)
const double DIV_BEATS[] = {1.0 / 8, 1.0 / 4, 1.0 / 3, 1.0 / 2, 3.0 / 4, 2.0 / 3, 1, 1.5, 2, 4, 8, 16};  // params.js DIVISIONS
const double BW8[] = {0.5098, 0.6013, 0.9, 2.5629};  // four biquads in a row: 8th-order Butterworth

double beatsOf(double div) { return DIV_BEATS[std::clamp(static_cast<int>(std::lround(div)), 0, 11)]; }
double amp(double db) { return std::pow(10.0, db / 20.0); }
double dbOf(double x) { return x > 1e-9 ? 20 * std::log10(x) : -180; }
double coefMs(double ms, double sr) { return std::exp(-1.0 / (std::max(ms, 0.01) * 0.001 * sr)); }
bool on(double v) { return v >= 0.5; }
int pick(double v, int n) { return std::clamp(static_cast<int>(std::lround(v)), 0, n - 1); }
double logcosh(double x) { const double a = std::fabs(x); return a + std::log1p(std::exp(-2 * a)) - std::log(2.0); }

// RBJ biquad with Web Audio's formulas (shelves at slope 1), Q linear. Double precision.
struct Rbj {
  enum Type { NONE, LP, HP, BP, NOTCH, PEAK, LSHELF, HSHELF, AP };
  Type type = NONE;
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1[2] = {0, 0}, z2[2] = {0, 0};
  void set(Type t, double f, double q, double g, double sr) {
    type = t;
    if (t == NONE) return;
    f = clampd(f, 5.0, sr * 0.49); q = std::max(q, 1e-3);
    const double w = 2 * PI * f / sr, c = std::cos(w), s = std::sin(w), A = std::pow(10.0, g / 40), al = s / (2 * q);
    const double k = 2 * std::sqrt(A) * s / 2 * std::sqrt(2.0);  // 2·√A·α for a shelf
    double a0 = 1 + al;
    a1 = -2 * c; a2 = 1 - al;
    switch (t) {
      case LP: b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; break;
      case HP: b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; break;
      case BP: b0 = al; b1 = 0; b2 = -al; break;
      case NOTCH: b0 = 1; b1 = -2 * c; b2 = 1; break;
      case PEAK: b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a2 = 1 - al / A; break;
      case AP: b0 = 1 - al; b1 = -2 * c; b2 = 1 + al; break;
      case LSHELF:
        b0 = A * ((A + 1) - (A - 1) * c + k); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - k);
        a0 = (A + 1) + (A - 1) * c + k; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - k; break;
      case HSHELF:
        b0 = A * ((A + 1) + (A - 1) * c + k); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - k);
        a0 = (A + 1) - (A - 1) * c + k; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - k; break;
      default: break;
    }
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  }
  double run(int ch, double x) {
    if (type == NONE) return x;
    const double y = b0 * x + z1[ch];
    z1[ch] = b1 * x - a1 * y + z2[ch];
    z2[ch] = b2 * x - a2 * y;
    return y;
  }
  void reset() { z1[0] = z1[1] = z2[0] = z2[1] = 0; }
};

// dry and wet at equal power, moved once per block
struct WetDry {
  Smooth m; double dry = 1, wet = 0;
  void init(double sr, double v) { m.init(sr, 0.012, v); calc(); }
  void block(int n) { m.step(n); calc(); }
  void calc() { dry = std::cos(m.v * PI / 2); wet = std::sin(m.v * PI / 2); }
};

// First-order antiderivative anti-aliasing: the curve's average between this sample and the
// last, so a hard curve doesn't fold harmonics back below Nyquist.
template <typename Fn, typename Anti>
double adaa(double x, double& last, Fn f, Anti F) {
  const double d = x - last, y = std::fabs(d) < 1e-6 ? f(0.5 * (x + last)) : (F(x) - F(last)) / d;
  last = x;
  return y;
}

// a low-frequency oscillator in Web Audio's shapes
double wave(int shape, double ph) {
  switch (shape) {
    case 1: return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;  // triangle
    case 2: return ph < 0.5 ? 1 : -1;                                        // square
    case 3: return ph < 0.5 ? 2 * ph : 2 * ph - 2;                           // saw
    default: return std::sin(2 * PI * ph);
  }
}

// ---- EQ Eight ---------------------------------------------------------------------------
class EqEight : public Device {
 public:
  EqEight(double sr, std::vector<double> d) : Device(sr, std::move(d)) {
    for (auto& b : bands_) { b.lf.init(sr, 0.02, std::log(1000.0)); b.g.init(sr, 0.02, 0); b.q.init(sr, 0.02, 0.71); }
    out_.init(sr, 0.012, 1);
  }

 private:
  struct Band { Rbj f[4]; Smooth lf, g, q; int type = -1, n = 0; bool on = false, dirty = true; };
  void update() override {
    for (int b = 0; b < 8; b++) {
      Band& B = bands_[b];
      const double* p = &v_[b * 5];
      const int type = pick(p[1], 8);
      const bool o = on(p[0]), fresh = B.type < 0;
      B.lf.set(std::log(clampd(p[2], 10, 22000))); B.g.set(clampd(p[3], -15, 15)); B.q.set(clampd(p[4], 0.1, 18));
      if (fresh || type != B.type) { B.lf.jump(B.lf.target); B.g.jump(B.g.target); B.q.jump(B.q.target); }
      if (o && !B.on) for (auto& f : B.f) f.reset();  // switched on: no stale state
      B.type = type; B.on = o; B.dirty = true;
    }
    out_.set(amp(v_[40]));
  }
  void coeffs(Band& B) {
    static const Rbj::Type K[8] = {Rbj::HP, Rbj::HP, Rbj::LSHELF, Rbj::PEAK, Rbj::NOTCH, Rbj::HSHELF, Rbj::LP, Rbj::LP};
    const bool cut4 = B.type == 0 || B.type == 7, hasGain = B.type == 2 || B.type == 3 || B.type == 5;
    const bool flat = hasGain && std::fabs(B.g.v) < 1e-3 && B.g.settled();  // a band at 0 dB costs nothing
    B.n = !B.on || flat ? 0 : cut4 ? 4 : 1;
    for (int i = 0; i < B.n; i++) B.f[i].set(K[B.type], std::exp(B.lf.v), cut4 ? BW8[i] : B.q.v, hasGain ? B.g.v : 0, sr_);
  }
  void run(float* L, float* R, int n) override {
    for (auto& B : bands_) {
      if (!B.on && !B.dirty) continue;
      if (B.dirty || !B.lf.settled() || !B.g.settled() || !B.q.settled()) { B.lf.step(n); B.g.step(n); B.q.step(n); coeffs(B); B.dirty = false; }
    }
    for (int i = 0; i < n; i++) {
      double l = L[i], r = R[i];
      for (auto& B : bands_) for (int k = 0; k < B.n; k++) { l = B.f[k].run(0, l); r = B.f[k].run(1, r); }
      const double o = out_.next();
      L[i] = static_cast<float>(l * o); R[i] = static_cast<float>(r * o);
    }
  }
  std::array<Band, 8> bands_;
  Smooth out_;
};

// ---- Auto Filter -------------------------------------------------------------------------
class AutoFilter : public Device {
 public:
  AutoFilter(double sr, std::vector<double> d) : Device(sr, std::move(d)) {
    lf_.init(sr, 0.012, std::log(2000.0)); res_.init(sr, 0.012, 0.9); depth_.init(sr, 0.012, 0); mix_.init(sr, 1);
  }

 private:
  enum { TYPE, SLOPE, FREQ, RES, DRIVE, LFO, RATE, DIV, SYNC, SHAPE, MIX };
  void update() override {
    type_ = pick(v_[TYPE], 4); steep_ = pick(v_[SLOPE], 2) == 1; shape_ = pick(v_[SHAPE], 4);
    lf_.set(std::log(clampd(v_[FREQ], 20, 20000))); res_.set(clampd(v_[RES], 0.5, 12)); depth_.set(v_[LFO] * 3600);
    inc_ = (on(v_[SYNC]) ? bpm_ / 60 / beatsOf(v_[DIV]) : clampd(v_[RATE], 0.02, 20)) / sr_;
    a_ = amp(clampd(v_[DRIVE], 0, 24)); k_ = std::min(1.0, v_[DRIVE] / 3);
    mix_.m.set(clampd(v_[MIX], 0, 1));
    if (first_) { first_ = false; lf_.jump(lf_.target); res_.jump(res_.target); depth_.jump(depth_.target); mix_.m.jump(mix_.m.target); mix_.calc(); }
  }
  void run(float* L, float* R, int n) override {
    static const Rbj::Type K[4] = {Rbj::LP, Rbj::HP, Rbj::BP, Rbj::NOTCH};
    mix_.block(n);
    const double a = a_, k = k_;
    auto f = [a, k](double x) { return x + (std::tanh(a * x) - x) * k; };
    auto F = [a, k](double x) { return x * x / 2 + (logcosh(a * x) / a - x * x / 2) * k; };
    for (int s = 0; s < n; s += SUB) {
      const int m = std::min(SUB, n - s);
      lf_.step(m); res_.step(m); depth_.step(m);
      const double hz = std::exp(lf_.v) * std::pow(2.0, wave(shape_, phase_) * depth_.v / 1200);
      f1_.set(K[type_], hz, type_ < 2 && steep_ ? 0.5412 : res_.v, 0, sr_);  // 24 dB: a Butterworth stage, then the resonant one
      f2_.set(steep_ ? K[type_] : Rbj::NONE, hz, res_.v, 0, sr_);
      for (int i = s; i < s + m; i++) {
        for (int ch = 0; ch < 2; ch++) {
          const double x = (ch ? R : L)[i];
          double y = k > 0 ? adaa(clampd(x, -4, 4), last_[ch], f, F) : x;
          y = f2_.run(ch, f1_.run(ch, y));
          (ch ? R : L)[i] = static_cast<float>(x * mix_.dry + y * mix_.wet);
        }
        if ((phase_ += inc_) >= 1) phase_ -= 1;
      }
    }
  }
  Rbj f1_, f2_;
  Smooth lf_, res_, depth_;
  WetDry mix_;
  int type_ = 0, shape_ = 0;
  bool steep_ = true, first_ = true;
  double phase_ = 0, inc_ = 0, a_ = 1, k_ = 0, last_[2] = {0, 0};
};

// ---- Compressor, Gate, Limiter: ports of dynamics.worklet.js ------------------------------
class Compressor : public Device {
 public:
  Compressor(double sr, std::vector<double> d) : Device(sr, std::move(d)) {}

 private:
  enum { THRESHOLD, RATIO, ATTACK, RELEASE, KNEE, MAKEUP, RMS, MIX };
  void update() override { att_ = coefMs(v_[ATTACK], sr_); rel_ = coefMs(v_[RELEASE], sr_); avg_ = coefMs(10, sr_); }
  void run(float* L, float* R, int n) override {
    const double th = v_[THRESHOLD], slope = 1 / std::max(1.0, v_[RATIO]) - 1, knee = v_[KNEE], mix = v_[MIX], make = v_[MAKEUP];
    const bool rms = on(v_[RMS]);
    double most = 0;
    for (int i = 0; i < n; i++) {
      double lvl = std::max(std::fabs(L[i]), std::fabs(R[i]));
      if (rms) { ms_ = avg_ * ms_ + (1 - avg_) * lvl * lvl; lvl = std::sqrt(ms_); }
      const double over = dbOf(lvl) - th;
      const double gr = 2 * over < -knee ? 0 : knee > 0 && 2 * std::fabs(over) <= knee ? slope * (over + knee / 2) * (over + knee / 2) / (2 * knee) : slope * over;
      env_ = gr < env_ ? att_ * env_ + (1 - att_) * gr : rel_ * env_ + (1 - rel_) * gr;
      most = std::min(most, env_);
      const double g = amp(env_ + make) * mix + (1 - mix);
      L[i] = static_cast<float>(L[i] * g); R[i] = static_cast<float>(R[i] * g);
    }
    meter.store(most, std::memory_order_relaxed);
  }
  double env_ = 0, ms_ = 0, att_ = 0, rel_ = 0, avg_ = 0;
};

class Gate : public Device {
 public:
  Gate(double sr, std::vector<double> d) : Device(sr, std::move(d)) {}

 private:
  enum { THRESHOLD, RET, ATTACK, HOLD, RELEASE, FLOOR };
  void update() override { att_ = coefMs(v_[ATTACK], sr_); rel_ = coefMs(v_[RELEASE], sr_); fall_ = coefMs(1, sr_); }
  void run(float* L, float* R, int n) override {
    const double openAt = amp(v_[THRESHOLD]), closeAt = amp(v_[THRESHOLD] - v_[RET]), floor = v_[FLOOR] <= -80 ? 0 : amp(v_[FLOOR]);
    const double hold = v_[HOLD] * 0.001 * sr_;
    for (int i = 0; i < n; i++) {
      const double pk = std::max(std::fabs(L[i]), std::fabs(R[i]));
      peak_ = std::max(pk, peak_ * fall_);
      if (peak_ >= openAt) { open_ = true; held_ = hold; } else if (open_ && peak_ < closeAt && --held_ <= 0) open_ = false;
      const double to = open_ ? 1 : floor;
      g_ = to > g_ ? att_ * g_ + (1 - att_) * to : rel_ * g_ + (1 - rel_) * to;
      L[i] = static_cast<float>(L[i] * g_); R[i] = static_cast<float>(R[i] * g_);
    }
    meter.store(open_ ? 1 : 0, std::memory_order_relaxed);
  }
  bool open_ = false;
  double held_ = 0, g_ = 0, peak_ = 0, att_ = 0, rel_ = 0, fall_ = 0;
};

// Brickwall with 1.5 ms lookahead: the gain each sample needs, held at its lowest over the
// window, released, then averaged over the same window, so it's down before the peak arrives.
class Limiter : public Device {
 public:
  Limiter(double sr, std::vector<double> d) : Device(sr, std::move(d)), w_(std::max(2, static_cast<int>(std::lround(0.0015 * sr)))) {
    need_.assign(w_, 1); box_.assign(w_, 1); sum_ = w_;
    dl_[0].assign(w_ - 1, 0); dl_[1].assign(w_ - 1, 0);
  }

 private:
  enum { GAIN, CEILING, RELEASE };
  void update() override { rc_ = coefMs(v_[RELEASE], sr_); }
  void run(float* L, float* R, int n) override {
    const double gin = amp(v_[GAIN]), ceil = amp(v_[CEILING]);
    const int d = w_ - 1;
    double most = 1;
    for (int k = 0; k < n; k++) {
      const double a = L[k] * gin, b = R[k] * gin, pk = std::max(std::fabs(a), std::fabs(b));
      need_[i_] = pk > ceil ? ceil / pk : 1;
      double m = 1;
      for (double v : need_) m = std::min(m, v);
      rel_ = m < rel_ ? m : m + (rel_ - m) * rc_;
      sum_ += rel_ - box_[i_]; box_[i_] = rel_;
      if (!(i_ = (i_ + 1) % w_)) { sum_ = 0; for (double v : box_) sum_ += v; }  // keep the running sum honest
      const double g = std::min(1.0, sum_ / w_);
      most = std::min(most, g);
      const double ya = dl_[0][j_], yb = dl_[1][j_];
      dl_[0][j_] = a; dl_[1][j_] = b; j_ = (j_ + 1) % d;
      L[k] = static_cast<float>(clampd(ya * g, -ceil, ceil)); R[k] = static_cast<float>(clampd(yb * g, -ceil, ceil));
    }
    meter.store(dbOf(most), std::memory_order_relaxed);
  }
  int w_, i_ = 0, j_ = 0;
  std::vector<double> need_, box_, dl_[2];
  double sum_ = 0, rel_ = 1, rc_ = 0;
};

// ---- Saturator -------------------------------------------------------------------------
class Saturator : public Device {
 public:
  Saturator(double sr, std::vector<double> d) : Device(sr, std::move(d)) {
    out_.init(sr, 0.012, 1); mix_.init(sr, 1);
    for (auto& f : dc_) f.set(Rbj::HP, 10, 0.7071, 0, sr);
  }

 private:
  enum { TYPE, DRIVE, OUT, MIX };
  void update() override {
    type_ = pick(v_[TYPE], 4); a_ = amp(clampd(v_[DRIVE], 0, 36));
    out_.set(amp(v_[OUT])); mix_.m.set(clampd(v_[MIX], 0, 1));
    if (first_) { first_ = false; out_.jump(out_.target); mix_.m.jump(mix_.m.target); mix_.calc(); }
  }
  // the curves of devices.js SHAPES at drive a, and their antiderivatives
  double shape(double u) const {
    const double x = a_ * u;
    switch (type_) {
      case 1: return clampd(x, -1, 1);
      case 2: return std::tanh(x + 0.3) - std::tanh(0.3);
      case 3: return std::sin(x * PI / 2);
      default: return std::tanh(x);
    }
  }
  double anti(double u) const {
    const double a = a_, x = a * u;
    switch (type_) {
      case 1: return std::fabs(x) <= 1 ? a * u * u / 2 : std::fabs(u) - 1 / (2 * a);
      case 2: return logcosh(x + 0.3) / a - std::tanh(0.3) * u;
      case 3: return -std::cos(x * PI / 2) / (a * PI / 2);
      default: return logcosh(x) / a;
    }
  }
  void run(float* L, float* R, int n) override {
    mix_.block(n);
    auto f = [this](double u) { return shape(u); };
    auto F = [this](double u) { return anti(u); };
    for (int i = 0; i < n; i++) {
      const double o = out_.next();
      for (int ch = 0; ch < 2; ch++) {
        const double x = (ch ? R : L)[i];
        const double y = dc_[ch].run(ch, adaa(clampd(x, -4, 4), last_[ch], f, F)) * o;
        (ch ? R : L)[i] = static_cast<float>(x * mix_.dry + y * mix_.wet);
      }
    }
  }
  Rbj dc_[2];
  Smooth out_;
  WetDry mix_;
  int type_ = 0;
  bool first_ = true;
  double a_ = 1, last_[2] = {0, 0};
};

// ---- Redux and Utility -------------------------------------------------------------------
class Redux : public Device {
 public:
  Redux(double sr, std::vector<double> d) : Device(sr, std::move(d)) {}

 private:
  enum { BITS, DOWN, MIX };
  void update() override {}
  void run(float* L, float* R, int n) override {
    const double steps = std::pow(2.0, clampd(v_[BITS], 1, 16) - 1), down = clampd(v_[DOWN], 1, 40), mix = v_[MIX];
    for (int i = 0; i < n; i++) {
      if ((phase_ += 1) >= down) { phase_ -= down; held_[0] = std::round(L[i] * steps) / steps; held_[1] = std::round(R[i] * steps) / steps; }
      L[i] = static_cast<float>(L[i] * (1 - mix) + held_[0] * mix); R[i] = static_cast<float>(R[i] * (1 - mix) + held_[1] * mix);
    }
  }
  double phase_ = 0, held_[2] = {0, 0};
};

class Utility : public Device {
 public:
  Utility(double sr, std::vector<double> d) : Device(sr, std::move(d)) { gain_.init(sr, 0.012, 1); }

 private:
  enum { GAIN, WIDTH, BALANCE, MONO, FLIPL, FLIPR, DC };
  void update() override { gain_.set(amp(v_[GAIN])); if (first_) { first_ = false; gain_.jump(gain_.target); } }
  void run(float* L, float* R, int n) override {
    const double width = on(v_[MONO]) ? 0 : v_[WIDTH], bal = v_[BALANCE], r = 1 - 2 * PI * 5 / sr_;
    const double sl = (on(v_[FLIPL]) ? -1 : 1) * (bal > 0 ? 1 - bal : 1), sr = (on(v_[FLIPR]) ? -1 : 1) * (bal < 0 ? 1 + bal : 1);
    const bool dc = on(v_[DC]);
    for (int i = 0; i < n; i++) {
      double l = L[i], rr = R[i];
      if (dc) {
        const double yl = l - in_[0] + r * out_[0], yr = rr - in_[1] + r * out_[1];
        in_[0] = l; in_[1] = rr; out_[0] = yl; out_[1] = yr; l = yl; rr = yr;
      }
      const double g = gain_.next(), mid = (l + rr) / 2, side = (l - rr) / 2 * width;
      L[i] = static_cast<float>((mid + side) * g * sl); R[i] = static_cast<float>((mid - side) * g * sr);
    }
  }
  Smooth gain_;
  bool first_ = true;
  double in_[2] = {0, 0}, out_[2] = {0, 0};
};

// ---- Delay -------------------------------------------------------------------------------
// Left and right lines with a filter in each feedback path. Ping Pong feeds the input into
// the left line and crosses the feedback; Freeze holds what's in it. A moved time glides.
class DelayFx : public Device {
 public:
  DelayFx(double sr, std::vector<double> d) : Device(sr, std::move(d)) {
    line_.init(sr, 8.5);
    for (auto* s : {&time_, &same_, &cross_, &inL_, &inR_, &inRL_}) s->init(sr, 0.012, 0);
    time_.init(sr, 0.06, 0.375 * sr); mix_.init(sr, 0.35);
  }

 private:
  enum { SYNC, DIV, TIME, FB, PP, LO, HI, FREEZE, MIX };
  void update() override {
    const bool pp = on(v_[PP]), fz = on(v_[FREEZE]);
    const double secs = on(v_[SYNC]) ? beatsOf(v_[DIV]) * 60 / bpm_ : v_[TIME] / 1000, fb = fz ? 1 : clampd(v_[FB], 0, 0.95);
    time_.set(clampd(secs, 0.001, 8) * sr_);
    same_.set(pp ? 0 : fb); cross_.set(pp ? fb : 0);
    inL_.set(fz ? 0 : 1); inR_.set(fz || pp ? 0 : 1); inRL_.set(!fz && pp ? 1 : 0);
    for (int c = 0; c < 2; c++) { hp_[c].set(Rbj::HP, v_[LO], 0.7071, 0, sr_); lp_[c].set(Rbj::LP, v_[HI], 0.7071, 0, sr_); }
    mix_.m.set(clampd(v_[MIX], 0, 1));
    if (first_) { first_ = false; for (auto* s : {&time_, &same_, &cross_, &inL_, &inR_, &inRL_}) s->jump(s->target); mix_.m.jump(mix_.m.target); mix_.calc(); }
  }
  void run(float* L, float* R, int n) override {
    mix_.block(n);
    for (int i = 0; i < n; i++) {
      const double d = time_.next(), same = same_.next(), cross = cross_.next();
      const double tl = lp_[0].run(0, hp_[0].run(0, line_.read(0, d))), tr = lp_[1].run(1, hp_[1].run(1, line_.read(1, d)));
      const double x = L[i], y = R[i];
      line_.write(x * inL_.next() + y * inRL_.next() + tl * same + tr * cross, y * inR_.next() + tr * same + tl * cross);
      L[i] = static_cast<float>(x * mix_.dry + tl * mix_.wet); R[i] = static_cast<float>(y * mix_.dry + tr * mix_.wet);
    }
  }
  Delay line_;
  Rbj hp_[2], lp_[2];
  Smooth time_, same_, cross_, inL_, inR_, inRL_;
  WetDry mix_;
  bool first_ = true;
};

// ---- Reverb: an 8-line feedback delay network --------------------------------------------
// Pre-delay, early reflections tapped from it, two diffusers per side, then eight lines mixed
// by a Householder matrix with a damping filter and a decay gain in each, set so the tail falls
// 60 dB in Decay seconds. The lines drift slightly so the tail never rings metallic.
class Reverb : public Device {
 public:
  Reverb(double sr, std::vector<double> d) : Device(sr, std::move(d)) {
    pre_.init(sr, 0.4);
    for (auto& l : lines_) l.init(sr, 0.25);
    const int AP[2][2] = {{142, 379}, {165, 402}};
    for (int c = 0; c < 2; c++) for (int k = 0; k < 2; k++) ap_[c][k].assign(static_cast<size_t>(AP[c][k] * sr / 44100), 0.f);
    for (int i = 0; i < N; i++) len_[i].init(sr, 0.08, BASE_MS[i] * 0.001 * sr);
    preS_.init(sr, 0.06, 0.015 * sr); width_.init(sr, 0.012, 1); mix_.init(sr, 0.3);
  }

 private:
  enum { PRE, SIZE, DECAY, DAMP, LO, HI, WIDTH, MIX };
  static constexpr int N = 8;
  static constexpr double BASE_MS[N] = {29.7, 37.1, 41.1, 43.7, 53.3, 59.9, 67.1, 73.9};
  static constexpr double ER_MS[8] = {4.3, 7.9, 11.3, 15.7, 21.1, 26.9, 33.7, 41.3};
  static constexpr double OUT = 0.32;  // the tail's level against the dry sound, as a convolution reverb normalises it
  void update() override {
    const double scale = 0.45 + clampd(v_[SIZE], 0, 1) * 1.3, decay = clampd(v_[DECAY], 0.2, 20);
    for (int i = 0; i < N; i++) {
      len_[i].set(BASE_MS[i] * scale * 0.001 * sr_);
      g_[i] = std::pow(10.0, -3 * BASE_MS[i] * scale * 0.001 / decay);
    }
    er_ = (0.3 + clampd(v_[SIZE], 0, 1)) * 0.001 * sr_;
    damp_ = std::exp(-2 * PI * clampd(v_[DAMP], 500, 20000) / sr_);
    preS_.set(clampd(v_[PRE], 0.5, 250) * 0.001 * sr_);
    for (int c = 0; c < 2; c++) { lo_[c].set(Rbj::HP, v_[LO], 0.7071, 0, sr_); hi_[c].set(Rbj::LP, v_[HI], 0.7071, 0, sr_); }
    width_.set(clampd(v_[WIDTH], 0, 1)); mix_.m.set(clampd(v_[MIX], 0, 1));
    if (first_) { first_ = false; for (auto& l : len_) l.jump(l.target); preS_.jump(preS_.target); width_.jump(width_.target); mix_.m.jump(mix_.m.target); mix_.calc(); }
  }
  double diffuse(int c, double x) {
    for (int k = 0; k < 2; k++) {
      auto& b = ap_[c][k];
      size_t& at = apAt_[c][k];
      const double d = b[at], y = -0.6 * x + d;
      b[at] = static_cast<float>(x + 0.6 * y);
      at = (at + 1) % b.size();
      x = y;
    }
    return x;
  }
  void run(float* L, float* R, int n) override {
    mix_.block(n);
    const double drift = 0.0004 * sr_, step = 0.31 / sr_;
    for (int i = 0; i < n; i++) {
      const double x = L[i], y = R[i], pre = preS_.next(), w = width_.next();
      pre_.write(x, y);
      double el = 0, er = 0;
      for (int k = 0; k < 8; k++) { const double t = pre_.read(k & 1, pre + ER_MS[k] * er_), g = 0.42 * (1 - k / 10.0); (k & 1 ? er : el) += t * g; }
      const double dl = diffuse(0, pre_.read(0, pre)), dr = diffuse(1, pre_.read(1, pre));
      if ((mod_ += step) >= 1) mod_ -= 1;
      double s[N], sum = 0;
      for (int k = 0; k < N; k++) {
        const double at = len_[k].next() + drift * std::sin(2 * PI * (mod_ + k * 0.125));
        const double v = lines_[k / 2].read(k & 1, at);
        lp_[k] += (1 - damp_) * (v - lp_[k]);
        s[k] = lp_[k] * g_[k];
        sum += s[k];
      }
      double ol = 0, orr = 0;
      for (int k = 0; k < N; k++) (k & 1 ? orr : ol) += s[k];
      for (int k = 0; k < N; k += 2) {
        const double a = s[k] - sum / 4 + dl * 0.5, b = s[k + 1] - sum / 4 + dr * 0.5;
        lines_[k / 2].write(a, b);
      }
      double wl = ol * OUT + el, wr = orr * OUT + er;
      const double mid = (wl + wr) / 2, side = (wl - wr) / 2 * w;
      wl = hi_[0].run(0, lo_[0].run(0, mid + side)); wr = hi_[1].run(1, lo_[1].run(1, mid - side));
      L[i] = static_cast<float>(x * mix_.dry + wl * mix_.wet); R[i] = static_cast<float>(y * mix_.dry + wr * mix_.wet);
    }
  }
  Delay pre_;
  std::array<Delay, N / 2> lines_;
  std::array<Smooth, N> len_;
  std::vector<float> ap_[2][2];
  size_t apAt_[2][2] = {{0, 0}, {0, 0}};
  double g_[N] = {}, lp_[N] = {}, damp_ = 0, er_ = 0, mod_ = 0;
  Rbj lo_[2], hi_[2];
  Smooth preS_, width_;
  WetDry mix_;
  bool first_ = true;
};

// ---- Chorus and Phaser -------------------------------------------------------------------
class Chorus : public Device {
 public:
  Chorus(double sr, std::vector<double> d) : Device(sr, std::move(d)) { line_.init(sr, 0.1); base_.init(sr, 0.03, 0.008 * sr); fb_.init(sr, 0.012, 0); mix_.init(sr, 0.5); }

 private:
  enum { RATE, DELAY, DEPTH, FB, MIX };
  void update() override {
    base_.set(clampd(v_[DELAY], 0.5, 30) * 0.001 * sr_); depth_ = clampd(v_[DEPTH], 0, 1) * 0.9;
    fb_.set(clampd(v_[FB], -0.9, 0.9)); inc_ = clampd(v_[RATE], 0.02, 20) / sr_; mix_.m.set(clampd(v_[MIX], 0, 1));
    if (first_) { first_ = false; base_.jump(base_.target); fb_.jump(fb_.target); mix_.m.jump(mix_.m.target); mix_.calc(); }
  }
  void run(float* L, float* R, int n) override {
    mix_.block(n);
    for (int i = 0; i < n; i++) {
      const double b = base_.next(), sw = std::sin(2 * PI * phase_) * depth_ * b, fb = fb_.next();
      if ((phase_ += inc_) >= 1) phase_ -= 1;
      const double tl = line_.read(0, b + sw), tr = line_.read(1, b - sw), x = L[i], y = R[i];
      line_.write(x + tl * fb, y + tr * fb);
      L[i] = static_cast<float>(x * mix_.dry + tl * mix_.wet); R[i] = static_cast<float>(y * mix_.dry + tr * mix_.wet);
    }
  }
  Delay line_;
  Smooth base_, fb_;
  WetDry mix_;
  bool first_ = true;
  double depth_ = 0, inc_ = 0, phase_ = 0;
};

class Phaser : public Device {
 public:
  Phaser(double sr, std::vector<double> d) : Device(sr, std::move(d)) { lf_.init(sr, 0.012, std::log(700.0)); fb_.init(sr, 0.012, 0); mix_.init(sr, 0.5); }

 private:
  enum { POLES, FREQ, DEPTH, RATE, FB, MIX };
  void update() override {
    poles_ = (pick(v_[POLES], 3) + 1) * 4;
    lf_.set(std::log(clampd(v_[FREQ], 100, 8000))); depth_ = clampd(v_[DEPTH], 0, 1) * 3600;
    inc_ = clampd(v_[RATE], 0.02, 20) / sr_; fb_.set(clampd(v_[FB], 0, 0.9)); mix_.m.set(clampd(v_[MIX], 0, 1));
    if (first_) { first_ = false; lf_.jump(lf_.target); fb_.jump(fb_.target); mix_.m.jump(mix_.m.target); mix_.calc(); }
  }
  void run(float* L, float* R, int n) override {
    mix_.block(n);
    for (int s = 0; s < n; s += SUB) {
      const int m = std::min(SUB, n - s);
      lf_.step(m);
      const double hz = std::exp(lf_.v) * std::pow(2.0, std::sin(2 * PI * phase_) * depth_ / 1200);
      for (int k = 0; k < poles_; k++) st_[k].set(Rbj::AP, hz, 0.7, 0, sr_);
      for (int i = s; i < s + m; i++) {
        const double fb = fb_.next();
        for (int ch = 0; ch < 2; ch++) {
          const double x = (ch ? R : L)[i];
          double y = x + last_[ch] * fb;
          for (int k = 0; k < poles_; k++) y = st_[k].run(ch, y);
          last_[ch] = y;
          (ch ? R : L)[i] = static_cast<float>(x * mix_.dry + y * mix_.wet);
        }
        if ((phase_ += inc_) >= 1) phase_ -= 1;
      }
    }
  }
  Rbj st_[12];
  Smooth lf_, fb_;
  WetDry mix_;
  int poles_ = 8;
  bool first_ = true;
  double depth_ = 0, inc_ = 0, phase_ = 0, last_[2] = {0, 0};
};

// ---- the table: page names, parameter names in order, defaults ----------------------------
using Params = std::vector<std::pair<std::string, double>>;
struct Spec { std::string type; Params params; std::function<std::unique_ptr<Device>(double, std::vector<double>)> make; };

template <typename T>
std::function<std::unique_ptr<Device>(double, std::vector<double>)> maker() {
  return [](double sr, std::vector<double> d) { return std::unique_ptr<Device>(new T(sr, std::move(d))); };
}

Params eqParams() {
  const double B[8][3] = {{0, 30, 0}, {2, 90, 1}, {3, 250, 1}, {3, 700, 1}, {3, 1800, 1}, {3, 4500, 1}, {5, 9000, 1}, {7, 18000, 0}};
  Params p;
  for (int b = 0; b < 8; b++) {
    const std::string n = std::to_string(b + 1);
    p.insert(p.end(), {{"on" + n, B[b][2]}, {"t" + n, B[b][0]}, {"f" + n, B[b][1]}, {"g" + n, 0}, {"q" + n, 0.71}});
  }
  p.push_back({"out", 0});
  return p;
}

const std::vector<Spec>& specs() {
  static const std::vector<Spec> s = {
    {"eq", eqParams(), maker<EqEight>()},
    {"filter", {{"type", 0}, {"slope", 1}, {"freq", 2000}, {"res", 0.9}, {"drive", 0}, {"lfo", 0}, {"rate", 1}, {"div", 6}, {"sync", 0}, {"shape", 0}, {"mix", 1}}, maker<AutoFilter>()},
    {"comp", {{"threshold", -20}, {"ratio", 4}, {"attack", 10}, {"release", 100}, {"knee", 6}, {"makeup", 0}, {"rms", 0}, {"mix", 1}}, maker<Compressor>()},
    {"gate", {{"threshold", -40}, {"ret", 3}, {"attack", 0.1}, {"hold", 20}, {"release", 100}, {"floor", -80}}, maker<Gate>()},
    {"limiter", {{"gain", 0}, {"ceiling", -0.3}, {"release", 50}}, maker<Limiter>()},
    {"sat", {{"type", 0}, {"drive", 6}, {"out", 0}, {"mix", 1}}, maker<Saturator>()},
    {"redux", {{"bits", 16}, {"down", 1}, {"mix", 1}}, maker<Redux>()},
    {"delay", {{"sync", 1}, {"div", 4}, {"time", 375}, {"fb", 0.4}, {"pp", 0}, {"lo", 100}, {"hi", 8000}, {"freeze", 0}, {"mix", 0.35}}, maker<DelayFx>()},
    {"reverb", {{"pre", 15}, {"size", 0.5}, {"decay", 2.2}, {"damp", 7000}, {"lo", 120}, {"hi", 12000}, {"width", 1}, {"mix", 0.3}}, maker<Reverb>()},
    {"chorus", {{"rate", 0.5}, {"delay", 8}, {"depth", 0.4}, {"fb", 0}, {"mix", 0.5}}, maker<Chorus>()},
    {"phaser", {{"poles", 1}, {"freq", 700}, {"depth", 0.6}, {"rate", 0.4}, {"fb", 0.5}, {"mix", 0.5}}, maker<Phaser>()},
    {"utility", {{"gain", 0}, {"width", 1}, {"balance", 0}, {"mono", 0}, {"flipL", 0}, {"flipR", 0}, {"dc", 0}}, maker<Utility>()},
  };
  return s;
}

const Spec* find(const std::string& type) {
  for (const auto& s : specs()) if (s.type == type) return &s;
  return nullptr;
}

}  // namespace

std::unique_ptr<Device> makeDevice(const std::string& type, double sr) {
  const Spec* s = find(type);
  if (!s) return nullptr;
  std::vector<double> d;
  for (const auto& p : s->params) d.push_back(p.second);
  return s->make(sr, std::move(d));
}

int paramIndex(const std::string& type, const std::string& key) {
  const Spec* s = find(type);
  if (!s) return -1;
  for (size_t i = 0; i < s->params.size(); i++) if (s->params[i].first == key) return static_cast<int>(i);
  return -1;
}

std::string deviceTable() {
  std::string o = "{";
  for (const auto& s : specs()) {
    o += (o.size() > 1 ? ",\"" : "\"") + s.type + "\":{";
    for (size_t i = 0; i < s.params.size(); i++) { char b[64]; std::snprintf(b, sizeof b, "%s\"%s\":%g", i ? "," : "", s.params[i].first.c_str(), s.params[i].second); o += b; }
    o += "}";
  }
  return o + "}";
}

}  // namespace crate
