// The maths Crate's instruments need, without a C library: the same code runs in the native
// engine and, compiled to WebAssembly, in the browser engine, so both make the same sound.
// Accurate to about 1e-7; the per-sample paths use only multiply-adds. The few primitives a CPU
// does directly (floor, sqrt, abs, a bit copy) come from the compiler: GCC and Clang builtins,
// which wasm has as instructions, or MSVC's <cmath>.
#pragma once
#include <stdint.h>
#if defined(_MSC_VER) && !defined(__clang__)
#include <cmath>
#include <cstring>
#define SYNTH_FLOOR(x) std::floor(x)
#define SYNTH_FABS(x) std::fabs(x)
#define SYNTH_SQRT(x) std::sqrt(x)
#define SYNTH_COPY(d, s) std::memcpy(d, s, 4)
#else
#define SYNTH_FLOOR(x) __builtin_floor(x)
#define SYNTH_FABS(x) __builtin_fabs(x)
#define SYNTH_SQRT(x) __builtin_sqrt(x)
#define SYNTH_COPY(d, s) __builtin_memcpy(d, s, 4)
#endif

namespace synth {

constexpr float PI = 3.14159265358979f, TAU = 6.28318530717959f;

inline float fabsf_(float x) { return x < 0 ? -x : x; }
inline float floorf_(float x) { return static_cast<float>(SYNTH_FLOOR(static_cast<double>(x))); }
inline float sqrtf_(float x) { return static_cast<float>(SYNTH_SQRT(static_cast<double>(x))); }
inline float clampf(float x, float lo, float hi) { return x < lo ? lo : x > hi ? hi : x; }
inline float minf(float a, float b) { return a < b ? a : b; }
inline float maxf(float a, float b) { return a > b ? a : b; }
inline int clampi(int x, int lo, int hi) { return x < lo ? lo : x > hi ? hi : x; }

inline float bitsToFloat(uint32_t u) { float f; SYNTH_COPY(&f, &u); return f; }
inline uint32_t floatToBits(float f) { uint32_t u; SYNTH_COPY(&u, &f); return u; }

// 2^x: the integer part goes into the exponent, the rest is a series on [-0.5, 0.5]
inline float exp2f_(float x) {
  x = clampf(x, -126.f, 126.f);
  const float i = floorf_(x + 0.5f), f = x - i;
  const float p = 1.f + f * (0.693147181f + f * (0.240226507f + f * (0.0555041087f + f * (0.00961812911f + f * (0.00133335581f + f * 0.000154035304f)))));
  return p * bitsToFloat(static_cast<uint32_t>(static_cast<int>(i) + 127) << 23);
}
inline float expf_(float x) { return exp2f_(x * 1.44269504f); }

// log2(x) for x > 0: exponent plus 2·atanh of the mantissa, centred on 1
inline float log2f_(float x) {
  uint32_t u = floatToBits(x);
  int e = static_cast<int>((u >> 23) & 255) - 127;
  float m = bitsToFloat((u & 0x7fffff) | 0x3f800000);
  if (m > 1.41421356f) { m *= 0.5f; e++; }
  const float z = (m - 1) / (m + 1), z2 = z * z;
  return static_cast<float>(e) + 2.88539008f * z * (1 + z2 * (0.333333333f + z2 * (0.2f + z2 * 0.142857143f)));
}

// sin on any x: reduced to [-pi/2, pi/2], then a series to x^13
inline double sind(double x) {
  x -= 6.283185307179586 * SYNTH_FLOOR(x / 6.283185307179586 + 0.5);
  if (x > 1.5707963267948966) x = 3.141592653589793 - x;
  else if (x < -1.5707963267948966) x = -3.141592653589793 - x;
  const double x2 = x * x;
  return x * (1 + x2 * (-1.0 / 6 + x2 * (1.0 / 120 + x2 * (-1.0 / 5040 + x2 * (1.0 / 362880 + x2 * (-1.0 / 39916800 + x2 / 6227020800.0))))));
}
inline double cosd(double x) { return sind(x + 1.5707963267948966); }
inline float tanf_(float x) { return static_cast<float>(sind(x) / cosd(x)); }

// tanh for saturation: exact enough, smooth, and odd
inline float tanhf_(float x) {
  if (x > 9.f) return 1.f;
  if (x < -9.f) return -1.f;
  const float e = exp2f_(2.88539008f * x);  // e^(2x)
  return (e - 1) / (e + 1);
}
// a cheap soft clip for drive inside a voice: tanh's Padé shape, flat beyond ±3
inline float softclip(float x) {
  x = clampf(x, -3.f, 3.f);
  const float x2 = x * x;
  return x * (27 + x2) / (27 + 9 * x2);
}

// equal-tempered pitch: MIDI note (fractional) to Hz
inline float noteHz(float note) { return 440.f * exp2f_((note - 69.f) * (1.f / 12)); }

// a small, fast noise source
struct Rand {
  uint32_t s = 0x9e3779b9u;
  uint32_t next() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return s; }
  float bi() { return static_cast<float>(static_cast<int32_t>(next())) * (1.f / 2147483648.f); }  // -1..1
  float uni() { return static_cast<float>(next() >> 8) * (1.f / 16777216.f); }                      // 0..1
};

}  // namespace synth
