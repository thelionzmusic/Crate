#include "audio_io.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <map>

#ifdef CRATE_RTAUDIO
#include "RtAudio.h"
#endif

namespace crate {

using Clock = std::chrono::steady_clock;

struct AudioIO::Rt {
#ifdef CRATE_RTAUDIO
  std::map<std::string, std::unique_ptr<RtAudio>> hosts;  // one per API, kept for its device ids
  RtAudio* active = nullptr;
  std::map<std::string, std::vector<DeviceInfo>> seen;    // last listing per API
  static RtAudio::Api apiOf(const std::string& s) {
    if (s == "asio") return RtAudio::WINDOWS_ASIO;
    if (s == "wasapi") return RtAudio::WINDOWS_WASAPI;
    if (s == "alsa") return RtAudio::LINUX_ALSA;
    if (s == "pulse") return RtAudio::LINUX_PULSE;
    if (s == "core") return RtAudio::MACOSX_CORE;
    return RtAudio::RTAUDIO_DUMMY;
  }
  RtAudio* host(const std::string& api) {
    auto& h = hosts[api];
    if (!h) { h = std::make_unique<RtAudio>(apiOf(api)); h->showWarnings(false); }
    return h.get();
  }
#endif
};

AudioIO::AudioIO() : rt_(std::make_unique<Rt>()) {}
AudioIO::~AudioIO() { close(); }

std::vector<std::string> AudioIO::apis() const {
  std::vector<std::string> out;
#ifdef CRATE_RTAUDIO
  std::vector<RtAudio::Api> have;
  RtAudio::getCompiledApi(have);
  for (auto a : have) {
    if (a == RtAudio::WINDOWS_ASIO) out.push_back("asio");
    else if (a == RtAudio::WINDOWS_WASAPI) out.push_back("wasapi");
    else if (a == RtAudio::LINUX_ALSA) out.push_back("alsa");
    else if (a == RtAudio::LINUX_PULSE) out.push_back("pulse");
    else if (a == RtAudio::MACOSX_CORE) out.push_back("core");
  }
#endif
  out.push_back("null");
  return out;
}

std::vector<DeviceInfo> AudioIO::devices(const std::string& api) {
  std::vector<DeviceInfo> out;
  if (api == "null") {
    out.push_back({"null", "No output (silent)", 0, 8, {44100, 48000}, 48000, true});
    return out;
  }
#ifdef CRATE_RTAUDIO
  RtAudio* h = rt_->host(api);
  if (h == rt_->active) return rt_->seen[api];  // probing a running ASIO driver can stop it: use the last listing
  const unsigned def = h->getDefaultOutputDevice();
  for (unsigned id : h->getDeviceIds()) {
    RtAudio::DeviceInfo i = h->getDeviceInfo(id);
    if (i.outputChannels == 0) continue;
    out.push_back({api, i.name, id, static_cast<int>(i.outputChannels), i.sampleRates, i.preferredSampleRate, id == def});
  }
  rt_->seen[api] = out;
#endif
  return out;
}

void AudioIO::measure(double spent, double budget) {
  const double l = budget > 0 ? spent / budget : 0;
  load.store(load.load(std::memory_order_relaxed) * 0.95 + l * 0.05, std::memory_order_relaxed);
}

int AudioIO::callback(float* out, unsigned frames, int channels, bool underflow) {
  if (underflow) xruns.fetch_add(1, std::memory_order_relaxed);
  render_(out, channels, static_cast<int>(frames));
  return 0;
}

#ifdef CRATE_RTAUDIO
struct RtCallback {
  AudioIO* io; int channels; double budget;
  static int run(void* out, void*, unsigned frames, double, RtAudioStreamStatus status, void* user) {
    auto* self = static_cast<RtCallback*>(user);
    const auto t0 = Clock::now();
    self->io->callback(static_cast<float*>(out), frames, self->channels, (status & RTAUDIO_OUTPUT_UNDERFLOW) != 0);
    self->io->measure(std::chrono::duration<double>(Clock::now() - t0).count(), frames * self->budget);
    return 0;
  }
};
static RtCallback g_cb;  // lives as long as the stream; only one stream at a time
#endif

bool AudioIO::open(const OpenRequest& r, const Render& render, Opened& out, std::string& error) {
  close();
  render_ = render;
  xruns = 0; load = 0;
  if (r.api == "null") {
    const unsigned rate = r.rate ? r.rate : 48000, buffer = r.buffer ? r.buffer : 256;
    const int channels = std::max(2, r.channels);
    out = {"null", "No output (silent)", rate, buffer, channels, static_cast<double>(buffer) / rate};
    nullRun_ = true;
    const std::string rec = recordPath;
    nullThread_ = std::thread([this, rate, buffer, channels, rec] {
      std::vector<float> buf(static_cast<size_t>(buffer) * channels);
      FILE* wav = rec.empty() ? nullptr : std::fopen(rec.c_str(), "wb");
      uint32_t bytes = 0;
      auto u32 = [&](uint32_t v) { std::fwrite(&v, 4, 1, wav); };
      auto u16 = [&](uint16_t v) { std::fwrite(&v, 2, 1, wav); };
      if (wav) { std::fwrite("RIFF\0\0\0\0WAVEfmt ", 1, 16, wav); u32(16); u16(1); u16(2); u32(rate); u32(rate * 4); u16(4); u16(16); std::fwrite("data\0\0\0\0", 1, 8, wav); }
      const auto period = std::chrono::duration<double>(static_cast<double>(buffer) / rate);
      auto next = Clock::now();
      while (nullRun_) {
        const auto t0 = Clock::now();
        callback(buf.data(), buffer, channels, false);
        measure(std::chrono::duration<double>(Clock::now() - t0).count(), period.count());
        if (wav) {
          for (unsigned i = 0; i < buffer; i++)
            for (int c = 0; c < 2; c++) { const int16_t s = static_cast<int16_t>(std::max(-1.f, std::min(1.f, buf[i * channels + c])) * 32767); std::fwrite(&s, 2, 1, wav); bytes += 2; }
        }
        next += std::chrono::duration_cast<Clock::duration>(period);
        std::this_thread::sleep_until(next);
      }
      if (wav) { std::fseek(wav, 4, SEEK_SET); u32(36 + bytes); std::fseek(wav, 40, SEEK_SET); u32(bytes); std::fclose(wav); }
    });
    open_ = true;
    return true;
  }
#ifdef CRATE_RTAUDIO
  RtAudio* h = rt_->host(r.api);
  RtAudio::DeviceInfo info = h->getDeviceInfo(r.id);
  if (info.outputChannels == 0) { error = "That output isn't available. Is it plugged in?"; return false; }
  RtAudio::StreamParameters p;
  p.deviceId = r.id; p.firstChannel = 0;
  p.nChannels = static_cast<unsigned>(std::min<int>(std::max(2, r.channels), static_cast<int>(info.outputChannels)));
  RtAudio::StreamOptions o;
  o.flags = RTAUDIO_MINIMIZE_LATENCY | RTAUDIO_SCHEDULE_REALTIME;
  o.priority = 90;
  o.streamName = "Crate";
  unsigned rate = r.rate ? r.rate : (info.preferredSampleRate ? info.preferredSampleRate : 48000);
  unsigned frames = r.buffer ? r.buffer : 256;
  g_cb = {this, static_cast<int>(p.nChannels), 1.0 / rate};
  if (h->openStream(&p, nullptr, RTAUDIO_FLOAT32, rate, &frames, &RtCallback::run, &g_cb, &o) != RTAUDIO_NO_ERROR) {
    error = h->getErrorText(); if (h->isStreamOpen()) h->closeStream(); return false;
  }
  rate = h->getStreamSampleRate();
  g_cb.budget = 1.0 / rate;
  if (h->startStream() != RTAUDIO_NO_ERROR) { error = h->getErrorText(); h->closeStream(); return false; }
  rt_->active = h;
  const long lat = h->getStreamLatency();
  out = {r.api, info.name, rate, frames, static_cast<int>(p.nChannels), static_cast<double>(std::max<long>(lat, 0) + frames) / rate};
  open_ = true;
  return true;
#else
  error = "This build of Crate's engine has no sound card support";
  return false;
#endif
}

void AudioIO::close() {
  if (nullThread_.joinable()) { nullRun_ = false; nullThread_.join(); }
#ifdef CRATE_RTAUDIO
  if (rt_->active) {
    if (rt_->active->isStreamRunning()) rt_->active->stopStream();
    if (rt_->active->isStreamOpen()) rt_->active->closeStream();
    rt_->active = nullptr;
  }
#endif
  open_ = false;
}

}  // namespace crate
