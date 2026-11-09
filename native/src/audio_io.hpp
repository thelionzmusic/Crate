// Sound card output: ASIO and WASAPI through RtAudio on Windows, plus a "null" device that
// renders in real time with no hardware (tests, and machines without a usable output).
// All methods are called from the control thread; only the callback runs on the audio thread.
#pragma once
#include <atomic>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

namespace crate {

struct DeviceInfo {
  std::string api, name;
  unsigned id = 0;
  int outputs = 0;
  std::vector<unsigned> rates;
  unsigned preferredRate = 0;
  bool isDefault = false;
};

struct OpenRequest {
  std::string api;        // "asio", "wasapi", "null"
  unsigned id = 0;        // device id from listDevices()
  unsigned rate = 0;      // 0 = the device's preferred rate
  unsigned buffer = 256;  // frames
  int channels = 2;       // how many outputs to open
};

struct Opened {
  std::string api, name;
  unsigned rate = 0, buffer = 0;
  int channels = 0;
  double latency = 0;     // seconds from render to the speaker, as the driver reports it
};

using Render = std::function<void(float* out, int channels, int frames)>;

class AudioIO {
 public:
  AudioIO();
  ~AudioIO();
  std::vector<std::string> apis() const;
  std::vector<DeviceInfo> devices(const std::string& api);
  // opens and starts; on failure returns false with `error` set
  bool open(const OpenRequest& r, const Render& render, Opened& out, std::string& error);
  void close();
  bool isOpen() const { return open_; }
  std::atomic<uint32_t> xruns{0};
  std::atomic<double> load{0};   // share of each buffer's time spent rendering, smoothed
  std::string recordPath;        // null device only: write what it renders to a WAV file

 private:
  void measure(double spent, double budget);
  struct Rt;
  std::unique_ptr<Rt> rt_;
  Render render_;
  bool open_ = false;
  // null device
  std::thread nullThread_;
  std::atomic<bool> nullRun_{false};
  friend struct RtCallback;
 public:
  int callback(float* out, unsigned frames, int channels, bool underflow);
};

}  // namespace crate
