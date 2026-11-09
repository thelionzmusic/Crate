#include "deck.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace crate {

namespace {
constexpr int FADE = 96;              // frames for a declick fade
constexpr float INV = 1.0f / 32768.0f;
}  // namespace

void Deck::init(double sr) {
  N_ = static_cast<int>(std::lround(sr * 0.04)) & ~1;
  Hs_ = N_ / 2;
  delta_ = static_cast<int>(std::lround(sr * 0.008));
  win_.resize(N_);
  for (int i = 0; i < N_; i++) win_[i] = static_cast<float>(0.5 - 0.5 * std::cos(2 * 3.14159265358979323846 * i / N_));  // periodic Hann
  olaL_.assign(N_, 0.f); olaR_.assign(N_, 0.f);
  outL_.assign(N_ * 2, 0.f); outR_.assign(N_ * 2, 0.f);
}

Pcm* Deck::load(Pcm* pcm, double at) {
  Pcm* old = pcm_;
  pcm_ = pcm; p_ = pcm ? pcm->data.data() : nullptr; frames_ = pcm ? pcm->frames : 0;
  playing_ = false; gain_ = want_ = 0; pendingSeek_ = -1; loopOn_ = false;
  jump(at);
  return old;
}

Pcm* Deck::unload() { return load(nullptr, 0); }

void Deck::play() { if (pcm_) { playing_ = true; want_ = 1; } }
void Deck::pause() { want_ = 0; }
void Deck::seek(double frame) {
  if (playing_ && gain_ > 0) { pendingSeek_ = frame; want_ = 0; }
  else jump(frame);
}

void Deck::jump(double frame) {
  pos_ = std::max(0.0, std::min(static_cast<double>(frames_ - 1), frame));
  if (frames_ == 0) pos_ = 0;
  resetStretch();
}

void Deck::resetStretch() {
  apos_ = pos_; prev_ = -1; outN_ = 0;
  std::fill(olaL_.begin(), olaL_.end(), 0.f); std::fill(olaR_.begin(), olaR_.end(), 0.f);
}

void Deck::wrapLoop() {
  if (!loopOn_) return;
  const double len = loopB_ - loopA_;
  if (len > 0 && pos_ >= loopB_) {
    pos_ -= len;
    if (keylock_) { apos_ -= len; if (prev_ >= 0) prev_ -= static_cast<long long>(len); }
  }
}

// correlation of mono sums: the natural continuation at `a` against a candidate at `b`
double Deck::score(long long a, long long b, int len, int step) const {
  long long j0 = 0, j1 = len;
  if (a < 0) j0 = std::max(j0, -a);
  if (b < 0) j0 = std::max(j0, -b);
  j1 = std::min({j1, frames_ - a, frames_ - b});
  double s = 0;
  for (long long j = j0; j < j1; j += step) {
    const long long ia = (a + j) * 2, ib = (b + j) * 2;
    s += static_cast<double>(p_[ia] + p_[ia + 1]) * static_cast<double>(p_[ib] + p_[ib + 1]);
  }
  return s;
}

// WSOLA: one hop of Hs frames into the output FIFO
void Deck::grain() {
  long long start = std::llround(apos_);
  if (prev_ >= 0) {
    const long long nat = prev_ + Hs_;
    int best = 0;
    double top = -std::numeric_limits<double>::infinity();
    for (int k = -delta_; k <= delta_; k += 4) { const double s = score(nat, start + k, Hs_, 4); if (s > top) { top = s; best = k; } }
    const int c0 = best;
    for (int k = std::max(-delta_, c0 - 3); k <= std::min(delta_, c0 + 3); k++) {
      if (k == c0) continue;
      const double s = score(nat, start + k, Hs_, 2);
      if (s > top) { top = s; best = k; }
    }
    start += best;
  }
  const long long j0 = std::max<long long>(0, -start), j1 = std::min<long long>(N_, frames_ - start);
  for (long long j = j0; j < j1; j++) {
    const float w = win_[j] * INV;
    const long long i = (start + j) * 2;
    olaL_[j] += w * p_[i]; olaR_[j] += w * p_[i + 1];
  }
  std::copy_n(olaL_.begin(), Hs_, outL_.begin() + outN_);
  std::copy_n(olaR_.begin(), Hs_, outR_.begin() + outN_);
  outN_ += Hs_;
  std::copy(olaL_.begin() + Hs_, olaL_.end(), olaL_.begin()); std::fill(olaL_.end() - Hs_, olaL_.end(), 0.f);
  std::copy(olaR_.begin() + Hs_, olaR_.end(), olaR_.begin()); std::fill(olaR_.end() - Hs_, olaR_.end(), 0.f);
  prev_ = start; apos_ += Hs_ * rate_; pos_ = static_cast<double>(start + Hs_);
}

// vinyl: cubic Hermite, rate gliding across the block so tempo moves never zipper
void Deck::vinyl(float* L, float* R, int n, double r0, double r1) {
  const long long last = frames_ - 3;
  for (int i = 0; i < n; i++) {
    const double x = pos_;
    const long long k = static_cast<long long>(std::floor(x));
    const double f = x - static_cast<double>(k);
    if (k >= 1 && k <= last) {
      const int16_t* b = p_ + k * 2;
      for (int ch = 0; ch < 2; ch++) {
        const double a0 = b[-2 + ch] * INV, a1 = b[ch] * INV, a2 = b[2 + ch] * INV, a3 = b[4 + ch] * INV;
        const double c1 = 0.5 * (a2 - a0), c2 = a0 - 2.5 * a1 + 2 * a2 - 0.5 * a3, c3 = 0.5 * (a3 - a0) + 1.5 * (a1 - a2);
        (ch ? R : L)[i] = static_cast<float>(((c3 * f + c2) * f + c1) * f + a1);
      }
    } else { L[i] = 0; R[i] = 0; }
    pos_ += r0 + (r1 - r0) * (static_cast<double>(i) / n);
    if (loopOn_) wrapLoop();
  }
}

void Deck::declick(float* L, float* R, int n) {
  for (int i = 0; i < n; i++) {
    if (gain_ != want_) {
      gain_ += want_ > gain_ ? 1.0 / FADE : -1.0 / FADE;
      if (std::fabs(gain_ - want_) < 1.0 / FADE) gain_ = want_;
      if (gain_ == 0) {
        if (pendingSeek_ >= 0) { jump(pendingSeek_); pendingSeek_ = -1; want_ = 1; }
        else playing_ = false;
      }
    }
    L[i] *= static_cast<float>(gain_); R[i] *= static_cast<float>(gain_);
  }
}

bool Deck::render(float* L, float* R, int n) {
  const double target = target_;
  if (!pcm_ || (!playing_ && gain_ == 0)) { std::fill_n(L, n, 0.f); std::fill_n(R, n, 0.f); return false; }
  if (keylock_ && target > 0.25 && target < 2 && std::fabs(target - 1) > 0.0005) {
    rate_ = target;
    while (outN_ < n) { grain(); wrapLoop(); }
    std::copy_n(outL_.begin(), n, L); std::copy_n(outR_.begin(), n, R);
    std::copy(outL_.begin() + n, outL_.begin() + outN_, outL_.begin());
    std::copy(outR_.begin() + n, outR_.begin() + outN_, outR_.begin());
    outN_ -= n;
  } else {
    if (outN_) resetStretch();
    vinyl(L, R, n, rate_, target);
    rate_ = target; apos_ = pos_;
  }
  if (gain_ != want_ || gain_ != 1) declick(L, R, n);
  if (pos_ >= static_cast<double>(frames_)) {
    playing_ = false; want_ = gain_ = 0; pos_ = static_cast<double>(frames_);
    return true;
  }
  return false;
}

}  // namespace crate
