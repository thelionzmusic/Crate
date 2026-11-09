// Small DSP building blocks shared by the decks, mixer and effects.
// Everything here is allocation-free once constructed and safe to use on the audio thread.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

namespace crate {

constexpr double PI = 3.14159265358979323846;

inline double clampd(double v, double lo, double hi) { return v < lo ? lo : v > hi ? hi : v; }
// exponential sweep between two frequencies for 0..1 knobs, as fx.js does
inline double sweep(double lo, double hi, double k) { return lo * std::pow(hi / lo, k); }
// WebAudio's lowpass/highpass Q is in dB; ours is linear
inline double qFromDb(double db) { return std::pow(10.0, db / 20.0); }

// One-pole smoother matching WebAudio's setTargetAtTime: approaches the target with time constant tau.
struct Smooth {
  double v = 0, target = 0, k = 1;
  void init(double sr, double tau, double value) { k = 1.0 - std::exp(-1.0 / (tau * sr)); v = target = value; }
  void set(double t) { target = t; }
  void jump(double t) { v = target = t; }
  double next() { v += (target - v) * k; return v; }
  // advance n samples at once (for per-chunk parameters)
  double step(int n) { v = target + (v - target) * std::pow(1.0 - k, n); return v; }
  bool settled() const { return std::fabs(target - v) < 1e-7; }
};

// RBJ biquad, transposed direct form II, double precision so low corner frequencies stay clean.
struct Biquad {
  enum Type { LP, HP, AP };
  double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  double z1[2] = {0, 0}, z2[2] = {0, 0};
  void set(Type t, double f, double q, double sr) {
    f = clampd(f, 5.0, sr * 0.49);
    const double w = 2 * PI * f / sr, c = std::cos(w), s = std::sin(w), al = s / (2 * q), a0 = 1 + al;
    switch (t) {
      case LP: b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; break;
      case HP: b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; break;
      case AP: b0 = 1 - al; b1 = -2 * c; b2 = 1 + al; break;
    }
    a1 = -2 * c; a2 = 1 - al;
    b0 /= a0; b1 /= a0; b2 /= a0; a1 /= a0; a2 /= a0;
  }
  double run(int ch, double x) {
    const double y = b0 * x + z1[ch];
    z1[ch] = b1 * x - a1 * y + z2[ch];
    z2[ch] = b2 * x - a2 * y;
    return y;
  }
  void reset() { z1[0] = z1[1] = z2[0] = z2[1] = 0; }
};

// Stereo delay line with fractional (cubic) reads, for echoes and modulated delays.
class Delay {
 public:
  void init(double sr, double maxSeconds) {
    size_ = 1;
    while (size_ < static_cast<size_t>(sr * maxSeconds) + 8) size_ <<= 1;
    mask_ = size_ - 1;
    buf_[0].assign(size_, 0.f); buf_[1].assign(size_, 0.f); w_ = 0;
  }
  void write(double l, double r) { buf_[0][w_] = static_cast<float>(l); buf_[1][w_] = static_cast<float>(r); w_ = (w_ + 1) & mask_; }
  // read `samples` behind the last write (>= 1)
  double read(int ch, double samples) const {
    samples = clampd(samples, 1.0, static_cast<double>(size_ - 4));
    const double pos = static_cast<double>(w_) - samples;
    const double fl = std::floor(pos);
    const double f = pos - fl;
    const size_t i = static_cast<size_t>(static_cast<long long>(fl) & static_cast<long long>(mask_));
    const auto& b = buf_[ch];
    const double a0 = b[(i - 1) & mask_], a1 = b[i], a2 = b[(i + 1) & mask_], a3 = b[(i + 2) & mask_];
    const double c1 = 0.5 * (a2 - a0), c2 = a0 - 2.5 * a1 + 2 * a2 - 0.5 * a3, c3 = 0.5 * (a3 - a0) + 1.5 * (a1 - a2);
    return ((c3 * f + c2) * f + c1) * f + a1;
  }
  void clear() { std::fill(buf_[0].begin(), buf_[0].end(), 0.f); std::fill(buf_[1].begin(), buf_[1].end(), 0.f); }

 private:
  std::vector<float> buf_[2];
  size_t size_ = 0, mask_ = 0, w_ = 0;
};

// Peak meter with a short fall-off, read from another thread.
struct PeakFall {
  double v = 0, fall = 0.999;
  void init(double sr) { fall = std::exp(-1.0 / (0.03 * sr)); }
  void block(const float* l, const float* r, int n) {
    double p = 0;
    for (int i = 0; i < n; i++) { p = std::max(p, static_cast<double>(std::fabs(l[i]))); p = std::max(p, static_cast<double>(std::fabs(r[i]))); }
    v = std::max(p, v * std::pow(fall, n));
  }
};

}  // namespace crate
