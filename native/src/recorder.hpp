// Records the master output to a WAV file. The audio thread only copies samples into a
// lock-free ring; a writer thread drains it to disk, so recording never stalls the sound.
#pragma once
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

namespace crate {

class Recorder {
 public:
  ~Recorder() { stop(); }
  bool start(const std::string& path, double sampleRate);  // false if the file couldn't be made
  void stop();                                              // finishes the file
  bool recording() const { return on_.load(std::memory_order_acquire); }
  double seconds() const { return rate_ > 0 ? static_cast<double>(written_.load()) / rate_ : 0; }

  // audio thread: one block of stereo master
  void push(const float* l, const float* r, int n) {
    if (!on_.load(std::memory_order_acquire)) return;
    const uint64_t h = head_.load(std::memory_order_relaxed);
    if (h + static_cast<uint64_t>(n) - tail_.load(std::memory_order_acquire) > FRAMES) { dropped_++; return; }  // disk too slow
    for (int i = 0; i < n; i++) { const size_t k = ((h + i) % FRAMES) * 2; ring_[k] = l[i]; ring_[k + 1] = r[i]; }
    head_.store(h + n, std::memory_order_release);
  }

 private:
  static constexpr uint64_t FRAMES = 1 << 19;  // ~11 s at 48 kHz of slack for the disk
  void drain();
  void header(uint32_t dataBytes);
  std::vector<float> ring_ = std::vector<float>(FRAMES * 2);
  std::atomic<uint64_t> head_{0}, tail_{0}, written_{0};
  std::atomic<bool> on_{false}, quit_{false};
  std::atomic<int> dropped_{0};
  std::FILE* f_ = nullptr;
  std::thread writer_;
  double rate_ = 0;
};

}  // namespace crate
