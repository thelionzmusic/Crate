// crate-engine --selftest: renders through the real mixer offline and checks it sounds right.
// Runs in CI on every build. Prints one line per check and returns non-zero on any failure.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "mixer.hpp"

using namespace crate;

namespace {

constexpr double SR = 48000;
int failures = 0;

void check(bool ok, const char* name, const std::string& detail) {
  std::printf("%s  %-34s %s\n", ok ? "ok  " : "FAIL", name, detail.c_str());
  if (!ok) failures++;
}

std::string fmt(const char* f, double a, double b = 0) { char s[128]; std::snprintf(s, sizeof s, f, a, b); return s; }

Pcm* tone(double hz, double secs, double amp = 0.5) {
  auto* p = new Pcm();
  p->frames = static_cast<long long>(SR * secs);
  p->data.resize(static_cast<size_t>(p->frames) * 2);
  for (long long i = 0; i < p->frames; i++) {
    const auto v = static_cast<int16_t>(amp * 32767 * std::sin(2 * PI * hz * i / SR));
    p->data[i * 2] = v; p->data[i * 2 + 1] = v;
  }
  return p;
}

Pcm* impulse(double secs) {
  auto* p = new Pcm();
  p->frames = static_cast<long long>(SR * secs);
  p->data.assign(static_cast<size_t>(p->frames) * 2, 0);
  p->data[4000] = p->data[4001] = 30000;  // frame 2000
  return p;
}

// a mixer with deck A loaded and playing, everything else neutral
std::unique_ptr<Mixer> rig(Pcm* pcm, double rate = 1, bool keylock = false) {
  auto m = std::make_unique<Mixer>(SR);
  Command c{Op::Load, 0}; c.ptr = pcm; m->commands.push(c);
  Command k{Op::Keylock, 0}; k.flag = keylock; m->commands.push(k);
  Command r{Op::Rate, 0}; r.a = rate; r.flag = true; m->commands.push(r);
  m->commands.push(Command{Op::Play, 0});
  return m;
}

std::vector<float> render(Mixer& m, double secs) {
  const int n = static_cast<int>(SR * secs);
  std::vector<float> out(static_cast<size_t>(n) * 2);
  for (int at = 0; at < n; at += 256) m.render(out.data() + at * 2, 2, std::min(256, n - at));
  Trash t; while (m.trash.pop(t)) { if (t.kind == Trash::PCM) delete static_cast<Pcm*>(t.ptr); else delete static_cast<Effect*>(t.ptr); }
  return out;
}

double freq(const std::vector<float>& x, double from, double to) {  // zero crossings of the left channel
  int crossings = 0; const auto a = static_cast<size_t>(from * SR), b = static_cast<size_t>(to * SR);
  double first = -1, last = 0;
  for (size_t i = a + 1; i < b; i++)
    if (x[(i - 1) * 2] < 0 && x[i * 2] >= 0) {
      const double t = (i - 1) + x[(i - 1) * 2] / (x[(i - 1) * 2] - x[i * 2]);
      if (first < 0) first = t; else crossings++;
      last = t;
    }
  return crossings / ((last - first) / SR);
}

double rms(const std::vector<float>& x, double from, double to) {
  double s = 0; const auto a = static_cast<size_t>(from * SR), b = static_cast<size_t>(to * SR);
  for (size_t i = a; i < b; i++) s += x[i * 2] * x[i * 2];
  return std::sqrt(s / (b - a));
}

double peakAll(const std::vector<float>& x) { double p = 0; for (float v : x) p = std::max(p, static_cast<double>(std::fabs(v))); return p; }

void setParam(Mixer& m, Param p, double v) { Command c{Op::Param, 0}; c.which = p; c.a = v; m.commands.push(c); }

void fx(Mixer& m, const std::string& type, double mix, double p1, double p2, double beats) {
  Command t{Op::FxType, 0, 0}; t.ptr = makeEffect(type, SR).release(); m.commands.push(t);
  Command s{Op::FxSet, 0, 0}; s.flag = true; s.a = mix; s.b = p1; s.c = p2; s.d = beats; s.e = 120; m.commands.push(s);
}

}  // namespace

int selftest() {
  { auto m = rig(tone(440, 3), 1.08); auto o = render(*m, 2); const double f = freq(o, 0.5, 1.5);
    check(std::fabs(f - 475.2) < 1, "vinyl +8% raises the pitch", fmt("%.1f Hz (want 475.2)", f)); }

  { auto m = rig(tone(440, 4), 1.08, true); auto o = render(*m, 2.5); const double f = freq(o, 0.5, 2.0);
    const double pos = m->state.pos[0].load() / SR;
    check(std::fabs(f - 440) < 2, "key lock +8% keeps the pitch", fmt("%.1f Hz (want 440)", f));
    check(std::fabs(pos - 2.5 * 1.08) < 0.06, "key lock +8% plays faster", fmt("%.2f s after 2.5 s (want 2.70)", pos)); }

  { double worst = 0;
    for (double hz : {60.0, 220.0, 700.0, 2600.0, 9000.0}) {
      auto m = rig(tone(hz, 2)); auto o = render(*m, 1.5);
      worst = std::max(worst, std::fabs(20 * std::log10(rms(o, 0.5, 1.4) / (0.5 / std::sqrt(2.0)))));
    }
    check(worst < 0.7, "isolator sums flat", fmt("worst %.2f dB off", worst)); }

  { auto m = rig(tone(80, 2)); setParam(*m, LOW, 0); auto o = render(*m, 1.5);
    const double db = 20 * std::log10(rms(o, 0.6, 1.4) / (0.5 / std::sqrt(2.0)));
    check(db < -30, "low kill removes the bass", fmt("%.0f dB", db)); }

  { auto m = rig(tone(1000, 2)); setParam(*m, LPF, 200); auto o = render(*m, 1.5);
    const double db = 20 * std::log10(rms(o, 0.6, 1.4) / (0.5 / std::sqrt(2.0)));
    check(db < -20, "filter sweep cuts above it", fmt("%.0f dB at 1 kHz, low-pass at 200 Hz", db)); }

  { auto m = rig(tone(440, 2, 0.95)); setParam(*m, TRIM, 4); auto o = render(*m, 1.5);
    double p = 0; for (size_t i = static_cast<size_t>(0.2 * SR) * 2; i < o.size(); i++) p = std::max(p, static_cast<double>(std::fabs(o[i])));
    check(p <= 0.9 && p > 0.8, "limiter holds -1 dBFS at +12 dB in", fmt("peak %.3f (ceiling 0.891)", p)); }

  { auto m = rig(tone(440, 3)); render(*m, 0.5);
    Command s{Op::Seek, 0}; s.a = SR * 1.2345; m->commands.push(s);
    auto o = render(*m, 0.3); double jump = 0;
    for (size_t i = 1; i < o.size() / 2; i++) jump = std::max(jump, static_cast<double>(std::fabs(o[i * 2] - o[(i - 1) * 2])));
    check(jump < 0.06, "seeking doesn't click", fmt("largest step %.3f", jump)); }

  { auto m = rig(impulse(3)); fx(*m, "echo", 1, 0.5, 1, 1); auto o = render(*m, 1.2);
    size_t at = 0; double top = 0;
    for (size_t i = static_cast<size_t>(0.2 * SR); i < static_cast<size_t>(0.9 * SR); i++) if (std::fabs(o[i * 2]) > top) { top = std::fabs(o[i * 2]); at = i; }
    const double t = (at - 2000) / SR;
    check(std::fabs(t - 0.5) < 0.003, "echo: 1 beat at 120 BPM", fmt("first repeat at %.3f s (want 0.500)", t)); }

  for (const char* type : {"pingpong", "reverb", "flanger", "phaser", "gater", "crusher", "autofilter"}) {
    auto m = rig(tone(330, 3)); fx(*m, type, 0.8, 0.8, 0.5, 0.5); auto o = render(*m, 2);
    bool finite = true; for (float v : o) if (!std::isfinite(v)) finite = false;
    const double r = rms(o, 0.5, 1.9);
    check(finite && r > 0.01 && peakAll(o) <= 1.0, (std::string(type) + " runs clean").c_str(), fmt("rms %.3f", r));
  }

  { // 4 decks with key lock, 2 effects each: how much of one core does it take?
    auto m = std::make_unique<Mixer>(SR);
    const char* types[] = {"reverb", "flanger", "echo", "phaser", "gater", "autofilter", "pingpong", "crusher"};
    for (int d = 0; d < DECKS; d++) {
      Command c{Op::Load, static_cast<uint8_t>(d)}; c.ptr = tone(200 + 100 * d, 12); m->commands.push(c);
      Command r{Op::Rate, static_cast<uint8_t>(d)}; r.a = 1.04; r.flag = true; m->commands.push(r);
      m->commands.push(Command{Op::Play, static_cast<uint8_t>(d)});
      for (int s = 0; s < 2; s++) {
        Command t{Op::FxType, static_cast<uint8_t>(d), static_cast<uint8_t>(s)}; t.ptr = makeEffect(types[d * 2 + s], SR).release(); m->commands.push(t);
        Command f{Op::FxSet, static_cast<uint8_t>(d), static_cast<uint8_t>(s)}; f.flag = true; f.a = 0.5; f.b = 0.5; f.c = 0.5; f.d = 1; f.e = 125; m->commands.push(f);
      }
    }
    const auto t0 = std::chrono::steady_clock::now();
    render(*m, 10);
    const double spent = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    check(spent / 10 < 0.25, "4 decks + 8 effects, realtime cost", fmt("%.1f%% of one core", spent / 10 * 100));
  }

  std::printf(failures ? "%d failed\n" : "all passed\n", failures);
  return failures ? 1 : 0;
}
