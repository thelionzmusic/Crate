// What both halves of --selftest share: the check line, its counter, and measurements.
#pragma once
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

namespace crate::test {

constexpr double SR = 48000;
inline int failures = 0;

inline void check(bool ok, const char* name, const std::string& detail) {
  std::printf("%s  %-34s %s\n", ok ? "ok  " : "FAIL", name, detail.c_str());
  if (!ok) failures++;
}
inline std::string fmt(const char* f, double a, double b = 0) { char s[128]; std::snprintf(s, sizeof s, f, a, b); return s; }

// interleaved stereo, measured on the left channel between two times in seconds
inline double rms(const std::vector<float>& x, double from, double to) {
  double s = 0; const auto a = static_cast<size_t>(from * SR), b = static_cast<size_t>(to * SR);
  for (size_t i = a; i < b; i++) s += x[i * 2] * x[i * 2];
  return std::sqrt(s / static_cast<double>(b - a));
}
inline double freq(const std::vector<float>& x, double from, double to) {  // from zero crossings
  int n = 0; double first = -1, last = 0;
  for (size_t i = static_cast<size_t>(from * SR) + 1; i < static_cast<size_t>(to * SR); i++)
    if (x[(i - 1) * 2] < 0 && x[i * 2] >= 0) { const double t = (i - 1) + x[(i - 1) * 2] / (x[(i - 1) * 2] - x[i * 2]); if (first < 0) first = t; else n++; last = t; }
  return n / ((last - first) / SR);
}
// the loudest sample on either channel from `from` seconds on
inline double peak(const std::vector<float>& x, double from = 0) {
  double p = 0;
  for (size_t i = static_cast<size_t>(from * SR) * 2; i < x.size(); i++) p = std::max(p, static_cast<double>(std::fabs(x[i])));
  return p;
}

}  // namespace crate::test
