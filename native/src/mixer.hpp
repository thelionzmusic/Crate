// The native mixer: four decks into four channels, effects, crossfader, master limiter, headphone cue.
// Signal per channel (same as engine.js):
//   deck -> trim -> 3-band isolator (LR4 at 220 Hz / 2.6 kHz) -> filter -> FX 1 -> FX 2
//        -> [pre-fader: meter, headphone cue] -> channel fader -> crossfader -> master
// "External mixer" mode sends each deck straight to its own output pair instead.
//
// The audio thread only ever touches this through render(); everything else arrives as
// Commands through a queue and leaves as a snapshot (State) and freed pointers (Trash).
#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <mutex>

#include "deck.hpp"
#include "dsp.hpp"
#include "fx.hpp"

namespace crate {

constexpr int DECKS = 4;
constexpr int CHUNK = 64;  // internal processing block; parameters move at this rate

// ---------- lock-free single-consumer queue (producers serialise on a mutex)
template <typename T, int SIZE>
class Queue {
 public:
  bool push(const T& v) {
    std::lock_guard<std::mutex> g(m_);
    const uint32_t h = head_.load(std::memory_order_relaxed);
    if (h - tail_.load(std::memory_order_acquire) >= SIZE) return false;
    buf_[h % SIZE] = v; head_.store(h + 1, std::memory_order_release); return true;
  }
  bool pop(T& v) {  // consumer only
    const uint32_t t = tail_.load(std::memory_order_relaxed);
    if (t == head_.load(std::memory_order_acquire)) return false;
    v = buf_[t % SIZE]; tail_.store(t + 1, std::memory_order_release); return true;
  }
 private:
  std::array<T, SIZE> buf_{};
  std::atomic<uint32_t> head_{0}, tail_{0};
  std::mutex m_;
};

enum class Op : uint8_t {
  Load, Unload, Play, Pause, Seek, Rate, Keylock, Loop,           // deck
  Param,                                                           // channel parameter
  Mix,                                                             // master section parameter
  FxType, FxSet,                                                   // effect slot
  Route,                                                           // output routing
};

enum Param : uint8_t { TRIM, LOW, MID, HIGH, HPF, LPF, FADER, CUE, XF, NPARAMS };
enum MixParam : uint8_t { MASTER, PHONES_CUE, PHONES_MASTER, PHONES, NMIX };

struct Command {
  Op op;
  uint8_t deck = 0, slot = 0, which = 0;
  double a = 0, b = 0, c = 0, d = 0, e = 0;
  bool flag = false;
  void* ptr = nullptr;
};

struct Trash { enum Kind : uint8_t { PCM, FX } kind; void* ptr; };

// what the UI needs, published after every callback (seqlock: odd sequence = writing)
struct State {
  std::atomic<uint32_t> seq{0};
  std::atomic<double> time{0}, load{0};
  std::atomic<double> pos[DECKS], rate[DECKS], playing[DECKS], frames[DECKS], peak[DECKS], master{0};
  std::atomic<uint32_t> ended[DECKS];  // increments each time a deck runs off its end
  std::atomic<uint32_t> xruns{0};
};

struct Routing {
  bool external = false;
  int masterAt = 0;     // first channel of the master pair
  int phonesAt = -1;    // first channel of the headphone pair, -1 for none
};

class Mixer {
 public:
  explicit Mixer(double sr);
  ~Mixer();
  double sampleRate() const { return sr_; }

  // audio thread: fill `out` (interleaved, `channels` wide) with n frames
  void render(float* out, int channels, int n);

  Queue<Command, 4096> commands;
  Queue<Trash, 1024> trash;
  State state;

 private:
  struct Channel {
    Smooth p[NPARAMS];
    Biquad lo[2], mid[4], hi[2], hpf, lpf;
    FxSlot fx[2];
    PeakFall meter;
  };
  void apply(const Command& c);
  void chunk(int n);
  void publish(int n);
  void toss(Trash::Kind k, void* p) { if (p && !trash.push({k, p})) leaked_++; }

  double sr_;
  long long clock_ = 0;           // frames rendered since start
  std::array<Deck, DECKS> decks_;
  std::array<Channel, DECKS> ch_;
  Smooth mix_[NMIX];
  Routing route_;
  // lookahead limiter: audio is delayed LOOK frames so the gain is already down when a peak arrives
  static constexpr int LOOK = 64;
  float limBuf_[2][LOOK] = {};
  double limNeed_[LOOK] = {};
  int limAt_ = 0;
  double limGain_ = 1, limAtt_ = 0, limRel_ = 0;
  PeakFall masterMeter_;
  int leaked_ = 0;
  // chunk buffers
  float dL_[DECKS][CHUNK], dR_[DECKS][CHUNK];
  float mL_[CHUNK], mR_[CHUNK], cL_[CHUNK], cR_[CHUNK], pL_[CHUNK], pR_[CHUNK];
};

}  // namespace crate
