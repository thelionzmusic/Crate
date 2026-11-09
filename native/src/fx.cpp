#include "fx.hpp"

#include <array>
#include <cmath>

namespace crate {

namespace {
constexpr double T = 0.02;  // parameter smoothing, seconds (as fx.js)
double beatSec(double beats, double bpm) { return beats * 60.0 / (bpm > 0 ? bpm : 120.0); }

// sine LFO with a smoothed rate
struct Lfo {
  double phase = 0, inc = 0;
  void rate(double hz, double sr) { inc = hz / sr; }
  double sine() { const double v = std::sin(2 * PI * phase); phase += inc; if (phase >= 1) phase -= 1; return v; }
  double square() { const double v = phase < 0.5 ? 1.0 : -1.0; phase += inc; if (phase >= 1) phase -= 1; return v; }
};

class Echo : public Effect {
 public:
  explicit Echo(double sr) : sr_(sr) { send = true; d_.init(sr, 8.5); time_.init(sr, T, 0.375 * sr); fb_.init(sr, T, 0); lpf_.init(sr, T, 8000); }
  void update(const FxParams& p) override { time_.set(beatSec(p.beats, p.bpm) * sr_); fb_.set(p.p1 * 0.88); lpf_.set(sweep(900, 16000, p.p2)); }
  void process(float* L, float* R, int n) override {
    lp_.set(Biquad::LP, lpf_.step(n), 0.7071, sr_);
    for (int i = 0; i < n; i++) {
      const double t = time_.next(), fb = fb_.next();
      const double yl = lp_.run(0, d_.read(0, t)), yr = lp_.run(1, d_.read(1, t));
      d_.write(L[i] + yl * fb, R[i] + yr * fb);
      L[i] = static_cast<float>(yl); R[i] = static_cast<float>(yr);
    }
  }
 private:
  double sr_; Delay d_; Smooth time_, fb_, lpf_; Biquad lp_;
};

class PingPong : public Effect {
 public:
  explicit PingPong(double sr) : sr_(sr) { send = true; dl_.init(sr, 8.5); dr_.init(sr, 8.5); time_.init(sr, T, 0.25 * sr); fb_.init(sr, T, 0); lpf_.init(sr, T, 8000); }
  void update(const FxParams& p) override { time_.set(beatSec(p.beats, p.bpm) * sr_); fb_.set(p.p1 * 0.85); lpf_.set(sweep(900, 16000, p.p2)); }
  void process(float* L, float* R, int n) override {
    lp_.set(Biquad::LP, lpf_.step(n), 0.7071, sr_);
    for (int i = 0; i < n; i++) {
      const double t = time_.next(), fb = fb_.next();
      const double l = dl_.read(0, t), r = dr_.read(0, t);
      const double back = lp_.run(0, r) * fb;
      dl_.write(0.5 * (L[i] + R[i]) + back, 0);   // left repeats into right, right back into left
      dr_.write(l, 0);
      L[i] = static_cast<float>(l); R[i] = static_cast<float>(r);
    }
  }
 private:
  double sr_; Delay dl_, dr_; Smooth time_, fb_, lpf_; Biquad lp_;
};

// Freeverb (Jezar, public domain): 8 combs and 4 allpasses per side
class Reverb : public Effect {
 public:
  explicit Reverb(double sr) : sr_(sr) {
    send = true;
    static constexpr int combs[8] = {1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617}, aps[4] = {556, 441, 341, 225};
    const double k = sr / 44100.0;
    for (int ch = 0; ch < 2; ch++) {
      for (int i = 0; i < 8; i++) comb_[ch][i].buf.assign(static_cast<size_t>((combs[i] + ch * 23) * k), 0.f);
      for (int i = 0; i < 4; i++) ap_[ch][i].buf.assign(static_cast<size_t>((aps[i] + ch * 23) * k), 0.f);
    }
    room_.init(sr, T, 0.84); damp_.init(sr, T, 0.2); tone_.init(sr, T, 8000);
  }
  void update(const FxParams& p) override { room_.set(0.7 + 0.28 * p.p1); damp_.set(0.4 * (1 - p.p2)); tone_.set(sweep(1500, 16000, p.p2)); }
  void process(float* L, float* R, int n) override {
    const double room = room_.step(n), damp = damp_.step(n);
    lp_.set(Biquad::LP, tone_.step(n), 0.7071, sr_);
    for (int i = 0; i < n; i++) {
      const double in = (L[i] + R[i]) * 0.015;
      double out[2] = {0, 0};
      for (int ch = 0; ch < 2; ch++) {
        for (auto& c : comb_[ch]) out[ch] += c.run(in, room, damp);
        for (auto& a : ap_[ch]) out[ch] = a.run(out[ch]);
      }
      L[i] = static_cast<float>(lp_.run(0, out[0] * 1.7));  // wet level about the same as the dry
      R[i] = static_cast<float>(lp_.run(1, out[1] * 1.7));
    }
  }
 private:
  struct Comb {
    std::vector<float> buf; size_t i = 0; double store = 0;
    double run(double x, double fb, double damp) {
      const double y = buf[i];
      store = y * (1 - damp) + store * damp;
      buf[i] = static_cast<float>(x + store * fb);
      if (++i == buf.size()) i = 0;
      return y;
    }
  };
  struct Allpass {
    std::vector<float> buf; size_t i = 0;
    double run(double x) {
      const double b = buf[i], y = b - x;
      buf[i] = static_cast<float>(x + b * 0.5);
      if (++i == buf.size()) i = 0;
      return y;
    }
  };
  double sr_;
  std::array<std::array<Comb, 8>, 2> comb_;
  std::array<std::array<Allpass, 4>, 2> ap_;
  Smooth room_, damp_, tone_;
  Biquad lp_;
};

class Flanger : public Effect {
 public:
  explicit Flanger(double sr) : sr_(sr) { d_.init(sr, 0.05); depth_.init(sr, T, 0.002); fb_.init(sr, T, 0); hz_.init(sr, T, 0.25); }
  void update(const FxParams& p) override { hz_.set(1 / beatSec(p.beats, p.bpm)); depth_.set(0.0005 + p.p1 * 0.0032); fb_.set(p.p2 * 0.85); }
  void process(float* L, float* R, int n) override {
    lfo_.rate(hz_.step(n), sr_);
    for (int i = 0; i < n; i++) {
      const double t = (0.004 + lfo_.sine() * depth_.next()) * sr_, fb = fb_.next();
      const double yl = d_.read(0, t), yr = d_.read(1, t);
      d_.write(L[i] + yl * fb, R[i] + yr * fb);
      L[i] = static_cast<float>(L[i] + yl); R[i] = static_cast<float>(R[i] + yr);
    }
  }
 private:
  double sr_; Delay d_; Lfo lfo_; Smooth depth_, fb_, hz_;
};

class Phaser : public Effect {
 public:
  explicit Phaser(double sr) : sr_(sr) { depth_.init(sr, T, 400); q_.init(sr, T, 3); hz_.init(sr, T, 0.5); }
  void update(const FxParams& p) override { hz_.set(1 / beatSec(p.beats, p.bpm)); depth_.set(100 + p.p1 * 600); q_.set(0.3 + p.p2 * 6); }
  void process(float* L, float* R, int n) override {
    lfo_.rate(hz_.step(n), sr_);
    const double depth = depth_.step(n), q = q_.step(n);
    for (int i = 0; i < n; i += 16) {      // move the notches every 16 samples
      const int m = std::min(16, n - i);
      const double f = std::max(20.0, 700 + lfo_.sine() * depth);
      lfo_.phase += lfo_.inc * (m - 1); if (lfo_.phase >= 1) lfo_.phase -= std::floor(lfo_.phase);
      for (auto& a : st_) a.set(Biquad::AP, f, q, sr_);
      for (int j = i; j < i + m; j++) {
        double l = L[j], r = R[j];
        for (auto& a : st_) { l = a.run(0, l); r = a.run(1, r); }
        L[j] = static_cast<float>(L[j] + l); R[j] = static_cast<float>(R[j] + r);
      }
    }
  }
 private:
  double sr_; Lfo lfo_; Smooth depth_, q_, hz_; std::array<Biquad, 6> st_;
};

class Gater : public Effect {
 public:
  explicit Gater(double sr) : sr_(sr) { base_.init(sr, T, 1); depth_.init(sr, T, 0); hz_.init(sr, T, 8); sm_.init(sr, T, 2000); }
  void update(const FxParams& p) override { hz_.set(1 / beatSec(p.beats, p.bpm)); base_.set(1 - p.p1 / 2); depth_.set(p.p1 / 2); sm_.set(sweep(2000, 15, p.p2)); }
  void process(float* L, float* R, int n) override {
    lfo_.rate(hz_.step(n), sr_);
    lp_.set(Biquad::LP, sm_.step(n), qFromDb(1), sr_);
    for (int i = 0; i < n; i++) {
      const double g = base_.next() + depth_.next() * lp_.run(0, lfo_.square());
      L[i] = static_cast<float>(L[i] * g); R[i] = static_cast<float>(R[i] * g);
    }
  }
 private:
  double sr_; Lfo lfo_; Smooth base_, depth_, hz_, sm_; Biquad lp_;
};

class Crusher : public Effect {
 public:
  explicit Crusher(double sr) { bits_.init(sr, T, 16); hold_.init(sr, T, 1); }
  void update(const FxParams& p) override { bits_.set(16 - p.p1 * 13); hold_.set(1 + std::round(p.p2 * 30)); }
  void process(float* L, float* R, int n) override {
    const double steps = std::pow(2.0, bits_.step(n) - 1);
    const int hold = static_cast<int>(std::lround(hold_.step(n)));
    for (int i = 0; i < n; i++) {
      if (count_ <= 0) { held_[0] = std::round(L[i] * steps) / steps; held_[1] = std::round(R[i] * steps) / steps; count_ = hold; }
      count_--;
      L[i] = static_cast<float>(held_[0]); R[i] = static_cast<float>(held_[1]);
    }
  }
 private:
  Smooth bits_, hold_; double held_[2] = {0, 0}; int count_ = 0;
};

class AutoFilter : public Effect {
 public:
  explicit AutoFilter(double sr) : sr_(sr) { depth_.init(sr, T, 700); q_.init(sr, T, 7); hz_.init(sr, T, 1); }
  void update(const FxParams& p) override { hz_.set(1 / beatSec(p.beats, p.bpm)); depth_.set(100 + p.p1 * 1250); q_.set(0.7 + p.p2 * 14); }
  void process(float* L, float* R, int n) override {
    lfo_.rate(hz_.step(n), sr_);
    const double depth = depth_.step(n), q = qFromDb(q_.step(n));
    for (int i = 0; i < n; i += 16) {
      const int m = std::min(16, n - i);
      f_.set(Biquad::LP, std::max(20.0, 1400 + lfo_.sine() * depth), q, sr_);
      lfo_.phase += lfo_.inc * (m - 1); if (lfo_.phase >= 1) lfo_.phase -= std::floor(lfo_.phase);
      for (int j = i; j < i + m; j++) { L[j] = static_cast<float>(f_.run(0, L[j])); R[j] = static_cast<float>(f_.run(1, R[j])); }
    }
  }
 private:
  double sr_; Lfo lfo_; Smooth depth_, q_, hz_; Biquad f_;
};
}  // namespace

std::unique_ptr<Effect> makeEffect(const std::string& type, double sr) {
  if (type == "echo") return std::make_unique<Echo>(sr);
  if (type == "pingpong") return std::make_unique<PingPong>(sr);
  if (type == "reverb") return std::make_unique<Reverb>(sr);
  if (type == "flanger") return std::make_unique<Flanger>(sr);
  if (type == "phaser") return std::make_unique<Phaser>(sr);
  if (type == "gater") return std::make_unique<Gater>(sr);
  if (type == "crusher") return std::make_unique<Crusher>(sr);
  if (type == "autofilter") return std::make_unique<AutoFilter>(sr);
  return nullptr;
}

// ---------- slot
void FxSlot::init(double sr) {
  sr_ = sr; dry_.init(sr, T, 1); sendG_.init(sr, T, 0); wet_.init(sr, T, 0);
}

Effect* FxSlot::swap(Effect* fx) {
  Effect* old = fx_; fx_ = fx; dirty_ = true; quiet_ = 0;
  return old;
}

void FxSlot::set(bool on, double mix, const FxParams& p) {
  if (fx_ && fx_->send) { dry_.set(1); sendG_.set(on ? 1 : 0); wet_.set(mix); }  // tails ring out after off
  else { dry_.set(on ? std::cos(mix * PI / 2) : 1); sendG_.set(on ? 1 : 0); wet_.set(on ? std::sin(mix * PI / 2) : 0); }
  if (p.p1 != params_.p1 || p.p2 != params_.p2 || p.beats != params_.beats || std::fabs(p.bpm - params_.bpm) > 0.005) { params_ = p; dirty_ = true; }
  if (on) quiet_ = 0;
}

void FxSlot::process(float* L, float* R, int n) {
  if (!fx_) return;
  // nothing going in and the tail has died away: skip the effect entirely
  const bool feeding = sendG_.target > 0 || sendG_.v > 1e-6;
  if (!feeding && quiet_ > 64 && wet_.settled() && dry_.settled() && dry_.v == 1.0) return;
  if (dirty_) { fx_->update(params_); dirty_ = false; }
  double peak = 0;
  for (int i = 0; i < n; i++) { const double s = sendG_.next(); sendL_[i] = static_cast<float>(L[i] * s); sendR_[i] = static_cast<float>(R[i] * s); }
  fx_->process(sendL_, sendR_, n);
  for (int i = 0; i < n; i++) {
    const double d = dry_.next(), w = wet_.next();
    peak = std::max(peak, std::fabs(static_cast<double>(sendL_[i])) + std::fabs(static_cast<double>(sendR_[i])));
    L[i] = static_cast<float>(L[i] * d + sendL_[i] * w);
    R[i] = static_cast<float>(R[i] * d + sendR_[i] * w);
  }
  quiet_ = (!feeding && peak < 1e-5) ? quiet_ + 1 : 0;
}

}  // namespace crate
