// One deck of the native player: a port of web/js/engine/deck.worklet.js.
//
//   vinyl     pitch follows tempo; cubic Hermite interpolation, any speed
//   key lock  tempo changes, pitch doesn't; WSOLA with ~40 ms grains and a ±8 ms search
// Jumps fade out and in over 96 frames so nothing clicks. render() never allocates.
#pragma once
#include <cstdint>
#include <vector>

namespace crate {

// a decoded track: interleaved 16-bit stereo at the engine's sample rate
struct Pcm {
  std::vector<int16_t> data;
  long long frames = 0;
};

class Deck {
 public:
  void init(double sampleRate);
  // commands (audio thread)
  Pcm* load(Pcm* pcm, double at);  // returns the previous track, for the caller to free elsewhere
  Pcm* unload();
  void play();
  void pause();
  void seek(double frame);
  void setRate(double r, bool now) { target_ = r; if (now) rate_ = r; }
  void setKeylock(bool on) { keylock_ = on; resetStretch(); }
  void setLoop(double a, double b) { loopOn_ = b > a; loopA_ = a; loopB_ = b; }
  void clearLoop() { loopOn_ = false; }

  // fills n frames; returns true when the track reached its end during this call
  bool render(float* L, float* R, int n);

  double pos() const { return pos_; }
  double rate() const { return rate_; }
  bool playing() const { return playing_ && want_ > 0; }
  bool audible() const { return pcm_ && (playing_ || gain_ > 0); }
  long long frames() const { return frames_; }

 private:
  void jump(double frame);
  void resetStretch();
  void wrapLoop();
  double score(long long a, long long b, int len, int step) const;
  void grain();
  void vinyl(float* L, float* R, int n, double r0, double r1);
  void declick(float* L, float* R, int n);

  Pcm* pcm_ = nullptr;
  const int16_t* p_ = nullptr;
  long long frames_ = 0;
  double pos_ = 0, rate_ = 1, target_ = 1;
  bool playing_ = false, keylock_ = true;
  bool loopOn_ = false;
  double loopA_ = 0, loopB_ = 0;
  double gain_ = 0, want_ = 0, pendingSeek_ = -1;

  // WSOLA state
  int N_ = 0, Hs_ = 0, delta_ = 0;
  std::vector<float> win_, olaL_, olaR_, outL_, outR_;
  int outN_ = 0;
  double apos_ = 0;
  long long prev_ = -1;
};

}  // namespace crate
