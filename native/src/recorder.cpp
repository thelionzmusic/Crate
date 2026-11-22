#include "recorder.hpp"

#include <algorithm>
#include <chrono>
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#endif

namespace crate {

namespace {
void le32(std::FILE* f, uint32_t v) { const unsigned char b[4] = {uint8_t(v), uint8_t(v >> 8), uint8_t(v >> 16), uint8_t(v >> 24)}; std::fwrite(b, 1, 4, f); }
void le16(std::FILE* f, uint16_t v) { const unsigned char b[2] = {uint8_t(v), uint8_t(v >> 8)}; std::fwrite(b, 1, 2, f); }
}  // namespace

// 32-bit float stereo WAV; the sizes are filled in again when recording stops
void Recorder::header(uint32_t dataBytes) {
  std::fseek(f_, 0, SEEK_SET);
  std::fwrite("RIFF", 1, 4, f_); le32(f_, 36 + dataBytes); std::fwrite("WAVEfmt ", 1, 8, f_);
  le32(f_, 16); le16(f_, 3); le16(f_, 2); le32(f_, static_cast<uint32_t>(rate_));
  le32(f_, static_cast<uint32_t>(rate_) * 8); le16(f_, 8); le16(f_, 32);
  std::fwrite("data", 1, 4, f_); le32(f_, dataBytes);
}

bool Recorder::start(const std::string& path, double sampleRate) {
  stop();
#ifdef _WIN32
  const int n = MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, nullptr, 0);  // UTF-8 path, wide API
  std::wstring w(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, path.c_str(), -1, w.data(), n);
  f_ = _wfopen(w.c_str(), L"wb");
#else
  f_ = std::fopen(path.c_str(), "wb");
#endif
  if (!f_) return false;
  rate_ = sampleRate; head_ = tail_ = written_ = 0; dropped_ = 0; quit_ = false;
  header(0);
  writer_ = std::thread([this] { drain(); });
  on_.store(true, std::memory_order_release);
  return true;
}

void Recorder::drain() {
  for (;;) {
    const uint64_t t = tail_.load(std::memory_order_relaxed), h = head_.load(std::memory_order_acquire);
    if (h == t) {
      if (quit_.load()) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(20));
      continue;
    }
    const uint64_t n = h - t, at = t % FRAMES, first = std::min(n, FRAMES - at);
    std::fwrite(&ring_[at * 2], sizeof(float) * 2, first, f_);
    if (n > first) std::fwrite(&ring_[0], sizeof(float) * 2, n - first, f_);
    tail_.store(h, std::memory_order_release);
    written_ += n;
  }
}

void Recorder::stop() {
  if (!f_) return;
  on_.store(false, std::memory_order_release);
  quit_ = true;
  if (writer_.joinable()) writer_.join();
  header(static_cast<uint32_t>(std::min<uint64_t>(written_.load() * 8, 0xFFFFFFF0u)));
  std::fclose(f_); f_ = nullptr;
}

}  // namespace crate
