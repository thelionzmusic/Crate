// Band-limited single-cycle waves for the oscillators, built once from their harmonic series.
// Each shape is kept at 11 bandwidths (1024 harmonics down to 1); an oscillator reads the
// widest one whose top harmonic stays under Nyquist, so saws and squares don't alias as
// they go up. Reads interpolate within a table and morph between neighbouring shapes, as a
// wavetable synth's position knob does.
#pragma once
#include "math.hpp"

namespace synth {

constexpr int TBITS = 11, TSIZE = 1 << TBITS, LEVELS = 11, SHAPES = 6;
// sine, triangle, saw, square, 25% pulse, vowel (a saw with a formant around its 10th harmonic)
inline float gTables[SHAPES][LEVELS][TSIZE + 1];
inline bool gTablesReady = false;

namespace detail {
// in-place inverse FFT of N = TSIZE complex values (re, im), unscaled
inline void ifft(double* re, double* im) {
  for (int i = 1, j = 0; i < TSIZE; i++) {
    int bit = TSIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (int len = 2; len <= TSIZE; len <<= 1) {
    const double a = 6.283185307179586 / len, wr = cosd(a), wi = sind(a);
    for (int i = 0; i < TSIZE; i += len) {
      double cr = 1, ci = 0;
      for (int k = 0; k < len / 2; k++) {
        const int p = i + k, q = p + len / 2;
        const double xr = re[q] * cr - im[q] * ci, xi = re[q] * ci + im[q] * cr;
        re[q] = re[p] - xr; im[q] = im[p] - xi; re[p] += xr; im[p] += xi;
        const double t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}
// harmonic n of a shape as (sine amplitude, cosine amplitude)
inline void harmonic(int shape, int n, double& s, double& c) {
  const double PI_ = 3.141592653589793;
  s = c = 0;
  switch (shape) {
    case 0: s = n == 1; break;
    case 1: if (n & 1) s = 8 / (PI_ * PI_) / (n * n) * (((n - 1) / 2) & 1 ? -1 : 1); break;
    case 2: s = 2 / PI_ / n * (n & 1 ? 1 : -1); break;
    case 3: if (n & 1) s = 4 / PI_ / n; break;
    case 4: c = 2 / (PI_ * n) * sind(PI_ * n * 0.25); break;
    case 5: { const double x = (n - 10) / 4.0; s = 2 / PI_ / n * (1 + 3 * exp2f_(static_cast<float>(-1.4426950408889634 * x * x))); break; }
  }
}
}  // namespace detail

inline void buildTables() {
  if (gTablesReady) return;
  static double re[TSIZE], im[TSIZE];
  for (int shape = 0; shape < SHAPES; shape++) {
    float scale = 1;
    for (int level = 0; level < LEVELS; level++) {
      const int top = (TSIZE / 2) >> level;
      for (int i = 0; i < TSIZE; i++) re[i] = im[i] = 0;
      for (int n = 1; n <= top && n < TSIZE / 2; n++) {
        double s, c;
        detail::harmonic(shape, n, s, c);
        // x[t] = sum s·sin + c·cos  ⇔  X[n] = (c - i·s)/2, X[N-n] its conjugate
        re[n] = c / 2; im[n] = -s / 2; re[TSIZE - n] = c / 2; im[TSIZE - n] = s / 2;
      }
      detail::ifft(re, im);
      float* t = gTables[shape][level];
      if (level == 0) {  // every bandwidth of a shape at the full one's level, which peaks at 1
        double peak = 1e-9;
        for (int i = 0; i < TSIZE; i++) peak = SYNTH_FABS(re[i]) > peak ? SYNTH_FABS(re[i]) : peak;
        scale = static_cast<float>(1 / peak);
      }
      for (int i = 0; i < TSIZE; i++) t[i] = static_cast<float>(re[i]) * scale;
      t[TSIZE] = t[0];
    }
  }
  gTablesReady = true;
}

// the widest table whose top harmonic stays under Nyquist at this phase increment (2^32 = a cycle a sample)
inline int levelFor(uint32_t inc) {
  const uint32_t fit = inc ? 0x80000000u / inc : 0xffffffffu;  // harmonics under Nyquist
  int level = 0;
  while (level < LEVELS - 1 && static_cast<uint32_t>((TSIZE / 2) >> level) > fit) level++;
  return level;
}

// read shape position `w` (0..SHAPES-1, fractional morphs) at a 32-bit phase
inline float readWave(float w, int level, uint32_t phase) {
  const int s0 = clampi(static_cast<int>(w), 0, SHAPES - 1), s1 = s0 + 1 < SHAPES ? s0 + 1 : s0;
  const float mix = w - static_cast<float>(s0);
  const uint32_t i = phase >> (32 - TBITS);
  const float f = static_cast<float>(phase & ((1u << (32 - TBITS)) - 1)) * (1.f / (1u << (32 - TBITS)));
  const float* a = gTables[s0][level] + i;
  const float va = a[0] + (a[1] - a[0]) * f;
  if (mix <= 0.f) return va;
  const float* b = gTables[s1][level] + i;
  const float vb = b[0] + (b[1] - b[0]) * f;
  return va + (vb - va) * mix;
}

}  // namespace synth
