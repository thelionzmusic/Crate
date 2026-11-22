// crate-engine --selftest, Production's part: drives the studio with the same "s" command lines
// the page sends, through the real mixer, and checks what comes out.
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "mixer.hpp"
#include "selftest.hpp"
#include "studio.hpp"

using namespace crate;
using namespace crate::test;

namespace {

constexpr int LOOK = 64;  // the master limiter's lookahead delays everything this many frames
double db(double x) { return 20 * std::log10(std::max(x, 1e-12)); }

// a studio on a mixer, with Main and track t1 at unity, as the page sets one up
struct Rig {
  std::vector<std::string> said;
  Mixer m{SR};
  StudioControl s{[this](const std::string& msg) { said.push_back(msg); }};
  explicit Rig(bool track = true) {
    cmd("strip main m"); cmd("level main 1 0");
    if (track) { cmd("strip t1 t"); cmd("level t1 1 0"); }
  }
  void cmd(const std::string& line) { std::istringstream in(line); s.command(in, m); s.flush(); }
  // a sound as the server decodes it: raw 16-bit stereo, read by a loader thread
  void buf(int id, const std::vector<float>& mono) {
    const auto path = (std::filesystem::temp_directory_path() / ("crate-studio-test-" + std::to_string(id) + ".raw")).string();
    { std::ofstream f(path, std::ios::binary); for (float v : mono) { const auto x = static_cast<int16_t>(v * 32767); f.write(reinterpret_cast<const char*>(&x), 2); f.write(reinterpret_cast<const char*>(&x), 2); } }
    cmd("buf " + std::to_string(id) + " " + path);
    const std::string want = "\"type\":\"sbuf\",\"id\":" + std::to_string(id) + ",";
    for (int i = 0; i < 500; i++) {
      s.tick(&m);
      for (const auto& x : said) if (x.find(want) != std::string::npos) { std::filesystem::remove(path); return; }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    std::filesystem::remove(path);
  }
  std::vector<float> render(double secs) {
    const int n = static_cast<int>(SR * secs);
    std::vector<float> out(static_cast<size_t>(n) * 2);
    for (int at = 0; at < n; at += 256) { m.render(out.data() + at * 2, 2, std::min(256, n - at)); s.tick(&m); }
    return out;
  }
};

std::vector<float> tone(double hz, double secs, double a = 0.5) {
  std::vector<float> x(static_cast<size_t>(SR * secs));
  for (size_t i = 0; i < x.size(); i++) x[i] = static_cast<float>(a * std::sin(2 * PI * hz * i / SR));
  return x;
}
std::vector<float> click(double secs) { std::vector<float> x(static_cast<size_t>(SR * secs), 0.f); x[0] = 0.9f; return x; }

bool finite(const std::vector<float>& x) { for (float v : x) if (!std::isfinite(v)) return false; return true; }

// one tone through a chain on t1; returns the output
std::vector<float> through(const std::string& chain, const std::vector<std::string>& params, double hz = 1000, double a = 0.1, double secs = 1) {
  Rig r;
  r.buf(1, tone(hz, secs + 0.2, a));
  if (!chain.empty()) r.cmd("chain t1 " + chain);
  for (const auto& p : params) r.cmd("p " + p);
  r.cmd("play 1 t1 1 0 0 1 -1");
  return r.render(secs);
}

}  // namespace

void studioSelftest() {
  {  // a clip lands on the frame it was asked for
    Rig r; r.buf(1, click(0.2));
    r.cmd("play 1 t1 1 0.5 0 1 -1");
    const auto o = r.render(1);
    long at = -1;
    for (size_t i = 0; i < o.size() / 2; i++) if (std::fabs(o[i * 2]) > 0.1) { at = static_cast<long>(i); break; }
    check(at == static_cast<long>(0.5 * SR) + LOOK, "studio: a clip starts on its frame", fmt("frame %.0f (want %.0f)", static_cast<double>(at), 0.5 * SR + LOOK));
  }
  {  // stretched by playback rate, as warped clips are
    Rig r; r.buf(1, tone(440, 2));
    r.cmd("play 1 t1 1 0 0 1.1 -1");
    const double f = freq(r.render(1), 0.2, 0.9);
    check(std::fabs(f - 484) < 1, "studio: playback rate warps", fmt("%.1f Hz (want 484.0)", f));
  }
  {  // a stop fades rather than clicks, and is silent after
    Rig r; r.buf(1, tone(200, 2));
    r.cmd("play 1 t1 1 0 0 1 -1"); r.cmd("stop 1 0.3");
    const auto o = r.render(0.6);
    double step = 0; for (size_t i = static_cast<size_t>(0.29 * SR); i < static_cast<size_t>(0.32 * SR); i++) step = std::max(step, static_cast<double>(std::fabs(o[i * 2] - o[(i - 1) * 2])));
    check(peak(o, 0.31) < 1e-6 && step < 0.05, "studio: a stop fades out", fmt("after %.6f, largest step %.3f", peak(o, 0.31), step));
  }
  {  // EQ Eight: +12 dB on band 4 at 1 kHz
    const double dry = rms(through("", {}), 0.3, 0.9), wet = rms(through("1:eq:1", {"1 f4 1000", "1 g4 12", "1 q4 1"}), 0.3, 0.9);
    check(std::fabs(db(wet / dry) - 12) < 0.3, "studio: EQ Eight bell", fmt("%+.2f dB at 1 kHz (want +12)", db(wet / dry)));
  }
  {  // Auto Filter: low-pass at 200 Hz takes 2 kHz down by tens of dB
    const double dry = rms(through("", {}, 2000), 0.3, 0.9), wet = rms(through("1:filter:1", {"1 freq 200"}, 2000), 0.3, 0.9);
    check(db(wet / dry) < -40, "studio: Auto Filter 24 dB low-pass", fmt("%.0f dB at 2 kHz, cutoff 200 Hz", db(wet / dry)));
  }
  {  // Compressor: 10:1 from -40 dB
    const double dry = rms(through("", {}, 440, 0.5), 0.3, 0.9), wet = rms(through("1:comp:1", {"1 threshold -40", "1 ratio 10", "1 attack 1"}, 440, 0.5), 0.3, 0.9);
    check(db(wet / dry) < -20, "studio: Compressor turns down", fmt("%.1f dB", db(wet / dry)));
  }
  {  // Limiter on Main: 18 dB into a -6 dB ceiling
    Rig r; r.buf(1, tone(440, 1.2, 0.5));
    r.cmd("chain main 1:limiter:1"); r.cmd("p 1 gain 18"); r.cmd("p 1 ceiling -6");
    r.cmd("play 1 t1 1 0 0 1 -1");
    const double p = peak(r.render(1), 0.05);
    check(p <= std::pow(10, -6.0 / 20) * 1.0001 && p > 0.45, "studio: Limiter holds its ceiling", fmt("peak %.4f (ceiling 0.5012)", p));
  }
  {  // a post-fader send reaches its return, and a switched-off device is skipped
    Rig r; r.buf(1, tone(440, 1.2, 0.1));
    r.cmd("strip rA r 0"); r.cmd("level rA 1 0"); r.cmd("send t1 0 1");
    r.cmd("play 1 t1 1 0 0 1 -1");
    const double both = rms(r.render(0.6), 0.2, 0.5);
    r.cmd("chain t1 1:utility:0"); r.cmd("p 1 gain -35");
    const double off = rms(r.render(0.3), 0.1, 0.25);
    check(std::fabs(db(both / (0.1 / std::sqrt(2.0))) - 6.02) < 0.2 && std::fabs(db(off / both)) < 0.2, "studio: sends and bypass",
          fmt("send adds %+.2f dB (want +6.02); bypassed %+.2f dB", db(both / (0.1 / std::sqrt(2.0))), db(off / both)));
  }
  {  // groups: a track plays through its group (and that group's group), whatever order they're declared in
    Rig r; r.buf(1, tone(440, 2, 0.2));
    r.cmd("strip g1 t"); r.cmd("level g1 0.5 0"); r.cmd("strip g2 t"); r.cmd("level g2 0.5 0");
    r.cmd("route t1 g2"); r.cmd("route g2 g1");
    r.cmd("play 1 t1 1 0 0 1 -1");
    const double nested = db(rms(r.render(0.6), 0.2, 0.5) / (0.2 / std::sqrt(2.0)));
    r.cmd("level g1 0 0");
    const double muted = db(rms(r.render(0.4), 0.2, 0.35) / (0.2 / std::sqrt(2.0)));
    r.cmd("drop g2"); r.cmd("level g1 1 0");
    const double orphan = db(rms(r.render(0.4), 0.2, 0.35) / (0.2 / std::sqrt(2.0)));
    check(std::fabs(nested + 12.04) < 0.2 && muted < -80 && std::fabs(orphan) < 0.2, "studio: groups route and nest",
          fmt("two groups at half %+.2f dB (want -12.04), a group muted %.0f dB", nested, muted) + fmt(", its group gone %+.2f dB", orphan));
  }
  {  // Reverb: the tail falls about 30 dB a second at a 2 s decay
    Rig r; r.buf(1, click(0.1));
    r.cmd("chain t1 1:reverb:1"); r.cmd("p 1 mix 1"); r.cmd("p 1 decay 2"); r.cmd("p 1 pre 1");
    r.cmd("play 1 t1 1 0 0 1 -1");
    const auto o = r.render(1.6);
    const double drop = db(rms(o, 0.25, 0.45) / rms(o, 1.25, 1.45));
    check(finite(o) && drop > 22 && drop < 38, "studio: Reverb decays as set", fmt("%.1f dB in 1 s (want about 30)", drop));
  }
  for (const char* type : {"eq", "filter", "comp", "gate", "limiter", "sat", "redux", "delay", "reverb", "chorus", "phaser", "utility"}) {
    const auto o = through(std::string("1:") + type + ":1", {"1 mix 0.5", "1 lfo 0.5", "1 drive 12"}, 330, 0.4, 1.5);
    const double v = rms(o, 0.4, 1.4);
    check(finite(o) && v > 0.02 && peak(o) <= 0.892, (std::string("studio: ") + type + " runs clean").c_str(), fmt("rms %.3f", v));
  }
  {  // structure changes while playing: a device added, a track dropped, its voice gone with it
    Rig r; r.buf(1, tone(300, 3, 0.3));
    r.cmd("play 1 t1 1 0 0 1 -1"); r.render(0.2);
    r.cmd("chain t1 1:delay:1,2:reverb:1"); r.render(0.2);
    r.cmd("chain t1 2:reverb:1"); r.render(0.2);
    r.cmd("drop t1");
    const auto o = r.render(0.3);
    check(finite(o) && peak(o, 0.1) < 1e-6, "studio: rewiring while playing", fmt("after dropping the track %.6f", peak(o, 0.1)));
  }
  {  // a note through Crate FM: starts on its frame, at its pitch, and ends after its release
    Rig r; r.cmd("chain t1 1:fm:1");
    for (const char* p : {"blevel 0", "aatt 0", "aa 0", "arel 0.05", "ar 0.05"}) r.cmd(std::string("p 1 ") + p);
    r.cmd("note 7 t1 69 1 0.25 0.5");
    const auto o = r.render(1.2);
    int first = -1;
    for (size_t i = 0; i < o.size() / 2 && first < 0; i++) if (std::fabs(o[i * 2]) > 1e-4) first = static_cast<int>(i);
    const int want = static_cast<int>(0.25 * SR) + LOOK;
    const double hz = freq(o, 0.4, 0.7), tail = rms(o, 0.95, 1.2);
    check(std::abs(first - want) <= 2 && std::fabs(hz - 440) < 0.5 && db(tail) < -80, "studio: a note plays on its frame and pitch",
          fmt("at frame %.0f (want %.0f), %.2f Hz, then %.0f dB", first, want, hz, db(tail)));
  }
  {  // a stopped note ends early; an instrument switched off mid-note doesn't hang it when it's back
    Rig r; r.cmd("chain t1 1:fm:1"); r.cmd("p 1 ar 0.05"); r.cmd("p 1 arel 0.05");
    r.cmd("note 8 t1 60 1 0 10"); r.render(0.2);
    r.cmd("stop 8 0.3");
    const auto stopped = r.render(0.5);
    r.cmd("note 9 t1 64 1 0.7 10"); r.render(0.2);
    r.cmd("chain t1 1:fm:0"); r.render(0.1);
    r.cmd("stop 9 0"); r.cmd("chain t1 1:fm:1");
    const auto back = r.render(0.5);
    check(rms(stopped, 0.0, 0.05) > 0.01 && db(rms(stopped, 0.35, 0.5)) < -80 && db(rms(back, 0.2, 0.5)) < -80,
          "studio: notes stop, and none hang", fmt("after stop %.0f dB, after bypass %.0f dB", db(rms(stopped, 0.35, 0.5)), db(rms(back, 0.2, 0.5))));
  }
  {  // Crate Additive: an organ chord with the rotary on, heard in stereo, then gone after release
    Rig r; r.cmd("chain t1 2:add:1"); r.cmd("p 2 rotary 1"); r.cmd("p 2 fast 1");
    for (int n : {60, 64, 67}) r.cmd("note " + std::to_string(n) + " t1 " + std::to_string(n) + " 1 0 1");
    const auto o = r.render(1.6);
    double c = 0, a = 0, b = 0;
    for (size_t i = static_cast<size_t>(SR * 0.3); i < static_cast<size_t>(SR); i++) { c += o[i * 2] * o[i * 2 + 1]; a += o[i * 2] * o[i * 2]; b += o[i * 2 + 1] * o[i * 2 + 1]; }
    const double held = rms(o, 0.3, 1.0), after = rms(o, 1.4, 1.6), corr = c / std::sqrt(a * b);
    check(finite(o) && held > 0.05 && db(after) < -80 && corr < 0.97, "studio: Crate Additive plays and stops",
          fmt("%.0f dB held, L/R %.2f (the rotary), %.0f dB after", db(held), corr, db(after)));
  }
  {  // eight FM tracks of eight-note chords, four-voice unison, filtered: what it costs
    Rig r(false);
    for (int t = 1; t <= 8; t++) {
      const std::string k = "t" + std::to_string(t), d = std::to_string(t);
      r.cmd("strip " + k + " t"); r.cmd("level " + k + " 0.3 0"); r.cmd("chain " + k + " " + d + ":fm:1");
      for (const char* p : {"uni 4", "clevel 0.4", "ftype 2", "cutoff 3000"}) r.cmd("p " + d + " " + p);
      for (int n = 0; n < 8; n++) r.cmd("note " + std::to_string(t * 100 + n) + " " + k + " " + std::to_string(40 + n * 3 + t) + " 0.8 0 20");
    }
    const auto t0 = std::chrono::steady_clock::now();
    const auto o = r.render(10);
    const double spent = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    // an extreme load (256 four-operator voices): it must stay real time on any machine CI runs on
    check(finite(o) && spent / 10 < 1.0, "studio: 64 FM notes, unison 4, cost", fmt("%.1f%% of one core", spent / 10 * 100));
  }
  {  // a full set: 16 tracks, each EQ, Compressor, Saturator and Delay; 2 returns; a Limiter on Main
    Rig r(false);
    r.buf(1, tone(220, 12, 0.05));
    r.cmd("strip rA r 0"); r.cmd("level rA 1 0"); r.cmd("chain rA 900:reverb:1");
    r.cmd("strip rB r 1"); r.cmd("level rB 1 0"); r.cmd("chain rB 901:delay:1");
    r.cmd("chain main 902:limiter:1");
    for (int t = 1; t <= 16; t++) {
      const std::string k = "t" + std::to_string(t), b = std::to_string(t * 10);
      r.cmd("strip " + k + " t"); r.cmd("level " + k + " 0.5 0"); r.cmd("send " + k + " 0 0.3"); r.cmd("send " + k + " 1 0.2");
      r.cmd("chain " + k + " " + b + "1:eq:1," + b + "2:comp:1," + b + "3:sat:1," + b + "4:delay:1");
      r.cmd("play " + std::to_string(t) + " " + k + " 1 0 0 1 -1");
    }
    const auto t0 = std::chrono::steady_clock::now();
    const auto o = r.render(10);
    const double spent = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    check(finite(o) && spent / 10 < 0.5, "studio: 16 tracks, 64 devices, cost", fmt("%.1f%% of one core", spent / 10 * 100));
  }
}
