// Production's built-in effects, native: the same twelve devices, parameters and defaults as
// web/js/produce/fx/devices.js, so a set sounds and reads the same on either engine.
//
// A device is built on the control thread with its defaults, then handed to the audio thread.
// Parameters arrive by index (paramIndex maps the page's names) and take effect at the next
// block; anything a knob moves continuously is smoothed, so nothing zips or clicks.
#pragma once
#include <algorithm>
#include <atomic>
#include <cmath>
#include <memory>
#include <string>
#include <vector>

namespace crate {

class Instrument;

class Device {
 public:
  virtual ~Device() = default;
  void set(int k, double v) { if (k >= 0 && k < static_cast<int>(v_.size())) { v_[k] = v; dirty_ = true; } }
  void tempo(double bpm) { if (bpm > 0 && bpm != bpm_) { bpm_ = bpm; dirty_ = true; } }
  // in place, n <= 64 frames
  void process(float* L, float* R, int n) {
    if (dirty_) { dirty_ = false; update(); }
    run(L, R, n);
    float l = 0, r = 0;  // the output's peak, held until the page reads it
    for (int i = 0; i < n; i++) { l = std::max(l, std::fabs(L[i])); r = std::max(r, std::fabs(R[i])); }
    if (l > outL.load(std::memory_order_relaxed)) outL.store(l, std::memory_order_relaxed);
    if (r > outR.load(std::memory_order_relaxed)) outR.store(r, std::memory_order_relaxed);
  }
  double value(int k) const { return v_[k]; }
  virtual Instrument* instrument() { return nullptr; }
  // gain reduction in dB (Compressor, Limiter) or 1/0 for open/closed (Gate), read by the page
  std::atomic<double> meter{0};
  // the output's peak on each side since the page last read it, for every device's level meter
  std::atomic<float> outL{0}, outR{0};

 protected:
  Device(double sr, std::vector<double> defaults) : sr_(sr), v_(std::move(defaults)) {}
  virtual void update() = 0;                  // parameters or tempo changed
  virtual void run(float* L, float* R, int n) = 0;
  double sr_, bpm_ = 120;
  std::vector<double> v_;
  bool dirty_ = true;
};

// A device that plays notes: it replaces its strip's input with its sound. Notes reach it as
// events at frame offsets within the next process(), so they start and end on exact frames.
class Instrument : public Device {
 public:
  Instrument* instrument() override { return this; }
  void note(int offset, int id, int pitch, float vel, bool on) { if (events_ < MAXEV) ev_[events_++] = {offset, id, pitch, vel, on}; }
  virtual void releaseAll() = 0;
  // audio thread: the sample a sampling instrument plays (mono, at the engine's rate); null for none
  virtual void source(const float*, long long) {}

 protected:
  Instrument(double sr, std::vector<double> defaults) : Device(sr, std::move(defaults)) {}
  virtual void noteOn(int id, int pitch, float vel) = 0;
  virtual void noteOff(int id) = 0;
  virtual void render(float* L, float* R, int n) = 0;  // adds n frames
  void run(float* L, float* R, int n) override;

 private:
  static constexpr int MAXEV = 128;
  struct Ev { int at, id, pitch; float vel; bool on; };
  Ev ev_[MAXEV];
  int events_ = 0;
};

// a device by the page's type name, with its defaults; null if unknown
std::unique_ptr<Device> makeDevice(const std::string& type, double sr);
// a parameter's index by the page's name, or -1
int paramIndex(const std::string& type, const std::string& key);
// every device's parameters and defaults as JSON, for the test that keeps both engines in step
std::string deviceTable();

}  // namespace crate
