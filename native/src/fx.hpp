// Built-in effects: a port of web/js/engine/fx.js with the same knobs and the same musical timing.
// Effects are built off the audio thread (they own delay memory) and handed over by pointer.
#pragma once
#include <memory>
#include <string>

#include "dsp.hpp"

namespace crate {

struct FxParams { double p1 = 0.5, p2 = 0.6, beats = 1, bpm = 120; };

class Effect {
 public:
  virtual ~Effect() = default;
  virtual void update(const FxParams& p) = 0;                 // called when knobs or tempo change
  virtual void process(float* L, float* R, int n) = 0;        // in place: input -> effect output only
  bool send = false;                                           // send effects ring out after switching off
};

// "echo", "pingpong", "reverb", "flanger", "phaser", "gater", "crusher", "autofilter"; null if unknown
std::unique_ptr<Effect> makeEffect(const std::string& type, double sr);

// One effect slot in a channel: dry path plus a send into the effect and its wet return.
class FxSlot {
 public:
  void init(double sr);
  Effect* swap(Effect* fx);                                    // returns the old one to free elsewhere
  void set(bool on, double mix, const FxParams& p);
  void process(float* L, float* R, int n);                     // in place
  Effect* effect() const { return fx_; }

 private:
  Effect* fx_ = nullptr;
  Smooth dry_, sendG_, wet_;
  FxParams params_;
  bool dirty_ = true;
  int quiet_ = 0;                                              // chunks of silence from the effect, to stop running it
  float sendL_[64], sendR_[64];
  double sr_ = 48000;
};

}  // namespace crate
