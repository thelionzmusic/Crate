// crate-engine: Crate's native audio engine.
//
// Crate's page drives it over a local WebSocket with one-line text commands, and gets back
// the engine's state (positions, meters, load) as a small binary frame 100 times a second.
// Three threads: control (this loop: socket, device changes, building effects), audio (the
// driver callback, which only renders), and short-lived loaders that read decoded tracks.
//
// Usage: crate-engine --origin http://127.0.0.1:47800 [--port 0] [--record out.wav] [--selftest]
// Prints "PORT <n>" once listening. Exits when stdin closes, so it never outlives Crate.
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "audio_io.hpp"
#include "mixer.hpp"
#include "ws.hpp"

using namespace crate;

namespace {

constexpr const char* VERSION = "1";

std::string esc(const std::string& s) {
  std::string o;
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += c;
  }
  return o;
}

std::string err(const std::string& what, const std::string& msg) {
  return "{\"type\":\"error\",\"what\":\"" + esc(what) + "\",\"message\":\"" + esc(msg) + "\"}";
}

const std::map<std::string, Param> PARAMS = {{"trim", TRIM}, {"low", LOW}, {"mid", MID}, {"high", HIGH}, {"hpf", HPF},
                                              {"lpf", LPF}, {"fader", FADER}, {"cue", CUE}, {"xf", XF}};
const std::map<std::string, MixParam> MIX = {{"master", MASTER}, {"phonesCue", PHONES_CUE}, {"phonesMaster", PHONES_MASTER}, {"phones", PHONES}};

struct Loaded { int deck; long long seq; double at; Pcm* pcm; std::string error; int generation; };

class Engine {
 public:
  explicit Engine(WsServer& ws) : ws_(ws) {}
  ~Engine() { closeDevice(); for (auto& t : loaders_) if (t.joinable()) t.join(); }

  void command(const std::string& line);
  void tick();      // every few ms: finished loads, freed memory, state out
  AudioIO io;

 private:
  void closeDevice() {
    io.close();
    mixer_.reset();   // audio stopped: the mixer frees what it still holds
    generation_++;
  }
  void push(const Command& c) { if (mixer_ && !mixer_->commands.push(c)) ws_.sendText(err("queue", "Engine is busy")); }
  void sendState();

  WsServer& ws_;
  std::unique_ptr<Mixer> mixer_;
  Opened opened_;
  std::string fxType_[DECKS][2];
  int generation_ = 0;
  std::mutex doneM_;
  std::vector<Loaded> done_;
  std::vector<std::thread> loaders_;
};

void Engine::command(const std::string& line) {
  std::istringstream in(line);
  std::string cmd; in >> cmd;
  if (cmd.empty()) return;
  auto deck = [&] { int d = -1; in >> d; return d >= 0 && d < DECKS ? d : -1; };

  if (cmd == "hello") {
    std::string apis;
    for (const auto& a : io.apis()) apis += (apis.empty() ? "\"" : ",\"") + a + "\"";
    ws_.sendText(std::string("{\"type\":\"hello\",\"version\":\"") + VERSION + "\",\"apis\":[" + apis + "]}");
  } else if (cmd == "devices") {
    std::string api; in >> api;
    std::string list;
    for (const auto& d : io.devices(api)) {
      std::string rates;
      for (unsigned r : d.rates) rates += (rates.empty() ? "" : ",") + std::to_string(r);
      list += (list.empty() ? "" : ",") + std::string("{\"id\":") + std::to_string(d.id) + ",\"name\":\"" + esc(d.name) + "\",\"outputs\":" +
              std::to_string(d.outputs) + ",\"rates\":[" + rates + "],\"preferred\":" + std::to_string(d.preferredRate) +
              ",\"default\":" + (d.isDefault ? "true" : "false") + "}";
    }
    ws_.sendText("{\"type\":\"devices\",\"api\":\"" + esc(api) + "\",\"list\":[" + list + "]}");
  } else if (cmd == "open") {
    OpenRequest r; in >> r.api >> r.id >> r.rate >> r.buffer >> r.channels;
    closeDevice();
    std::string error;
    // RtAudio reports the rate only after opening, so open with a shim that renders silence until the mixer exists
    auto shared = std::make_shared<std::atomic<Mixer*>>(nullptr);
    auto shim = [shared](float* out, int channels, int frames) {
      Mixer* m = shared->load(std::memory_order_acquire);
      if (m) m->render(out, channels, frames); else std::memset(out, 0, sizeof(float) * static_cast<size_t>(channels) * frames);
    };
    Opened o;
    if (!io.open(r, shim, o, error)) { ws_.sendText(err("open", error.empty() ? "The output wouldn't open" : error)); return; }
    mixer_ = std::make_unique<Mixer>(o.rate);
    shared->store(mixer_.get(), std::memory_order_release);
    for (auto& d : fxType_) d[0] = d[1] = "";
    opened_ = o;
    char b[64]; std::snprintf(b, sizeof b, "%.6f", o.latency);
    ws_.sendText("{\"type\":\"opened\",\"api\":\"" + esc(o.api) + "\",\"name\":\"" + esc(o.name) + "\",\"rate\":" + std::to_string(o.rate) +
                 ",\"buffer\":" + std::to_string(o.buffer) + ",\"channels\":" + std::to_string(o.channels) + ",\"latency\":" + b + "}");
  } else if (cmd == "close") {
    closeDevice();
    ws_.sendText("{\"type\":\"closed\"}");
  } else if (!mixer_) {
    ws_.sendText(err(cmd, "No output is open"));
  } else if (cmd == "route") {
    Command c{Op::Route}; int ext = 0; in >> ext >> c.a >> c.b; c.flag = ext != 0; push(c);
  } else if (cmd == "load") {
    const int d = deck(); double at = 0; long long seq = 0; in >> at >> seq;
    std::string path; std::getline(in >> std::ws, path);
    if (d < 0 || path.empty()) return;
    const int gen = generation_;
    loaders_.emplace_back([this, d, at, seq, path, gen] {
      Loaded r{d, seq, at, nullptr, "", gen};
      std::ifstream f(std::filesystem::u8path(path), std::ios::binary | std::ios::ate);  // UTF-8 on Windows too
      if (!f) r.error = "Couldn't read the decoded track";
      else {
        const auto bytes = static_cast<size_t>(f.tellg());
        auto* p = new Pcm();
        p->frames = static_cast<long long>(bytes / 4);
        p->data.resize(static_cast<size_t>(p->frames) * 2);
        f.seekg(0);
        f.read(reinterpret_cast<char*>(p->data.data()), static_cast<std::streamsize>(p->frames * 4));
        r.pcm = p;
      }
      std::lock_guard<std::mutex> g(doneM_);
      done_.push_back(std::move(r));
    });
  } else if (cmd == "unload" || cmd == "play" || cmd == "pause") {
    const int d = deck(); if (d < 0) return;
    push(Command{cmd == "unload" ? Op::Unload : cmd == "play" ? Op::Play : Op::Pause, static_cast<uint8_t>(d)});
  } else if (cmd == "seek") {
    const int d = deck(); Command c{Op::Seek, static_cast<uint8_t>(d)}; in >> c.a; if (d >= 0) push(c);
  } else if (cmd == "rate") {
    const int d = deck(); Command c{Op::Rate, static_cast<uint8_t>(d)}; int now = 0; in >> c.a >> now; c.flag = now != 0; if (d >= 0) push(c);
  } else if (cmd == "keylock") {
    const int d = deck(); Command c{Op::Keylock, static_cast<uint8_t>(d)}; int on = 0; in >> on; c.flag = on != 0; if (d >= 0) push(c);
  } else if (cmd == "loop") {
    const int d = deck(); Command c{Op::Loop, static_cast<uint8_t>(d)}; std::string a; in >> a;
    if (a != "-") { c.a = std::stod(a); in >> c.b; c.flag = true; }
    if (d >= 0) push(c);
  } else if (cmd == "p") {
    const int d = deck(); std::string k; double v = 0; in >> k >> v;
    auto it = PARAMS.find(k); if (d < 0 || it == PARAMS.end()) return;
    Command c{Op::Param, static_cast<uint8_t>(d)}; c.which = it->second; c.a = v; push(c);
  } else if (cmd == "m") {
    std::string k; double v = 0; in >> k >> v;
    auto it = MIX.find(k); if (it == MIX.end()) return;
    Command c{Op::Mix}; c.which = it->second; c.a = v; push(c);
  } else if (cmd == "fx") {
    const int d = deck(); int slot = 0, on = 0; std::string type; in >> slot >> type >> on;
    if (d < 0 || slot < 0 || slot > 1) return;
    Command c{Op::FxSet, static_cast<uint8_t>(d), static_cast<uint8_t>(slot)};
    in >> c.a >> c.b >> c.c >> c.d >> c.e; c.flag = on != 0;
    if (fxType_[d][slot] != type) {  // built here, so the audio thread never allocates
      auto fx = makeEffect(type, mixer_->sampleRate());
      if (!fx) { ws_.sendText(err("fx", "Unknown effect " + type)); return; }
      Command t{Op::FxType, static_cast<uint8_t>(d), static_cast<uint8_t>(slot)}; t.ptr = fx.release();
      if (!mixer_->commands.push(t)) { delete static_cast<Effect*>(t.ptr); return; }
      fxType_[d][slot] = type;
    }
    push(c);
  } else {
    ws_.sendText(err(cmd, "Unknown command"));
  }
}

void Engine::tick() {
  std::vector<Loaded> ready;
  { std::lock_guard<std::mutex> g(doneM_); ready.swap(done_); }
  for (auto& r : ready) {
    if (!r.error.empty()) { ws_.sendText(err("load", r.error)); continue; }
    if (!mixer_ || r.generation != generation_) { delete r.pcm; continue; }  // the device changed meanwhile
    const long long frames = r.pcm->frames;
    Command c{Op::Load, static_cast<uint8_t>(r.deck)}; c.a = r.at; c.ptr = r.pcm;
    if (!mixer_->commands.push(c)) { delete r.pcm; ws_.sendText(err("load", "Engine is busy")); continue; }
    ws_.sendText("{\"type\":\"loaded\",\"deck\":" + std::to_string(r.deck) + ",\"seq\":" + std::to_string(r.seq) + ",\"frames\":" + std::to_string(frames) + "}");
  }
  // reap loader threads that have finished (they're done once their result is queued)
  if (!ready.empty() || loaders_.size() > 8) { for (auto& t : loaders_) if (t.joinable()) t.join(); loaders_.clear(); }
  if (mixer_) {
    Trash t;
    while (mixer_->trash.pop(t)) { if (t.kind == Trash::PCM) delete static_cast<Pcm*>(t.ptr); else delete static_cast<Effect*>(t.ptr); }
    sendState();
  }
}

// [time, latency, load, xruns, rate, then per deck: pos, rate, playing, frames, peak, then master peak, then 4 ended counters]
void Engine::sendState() {
  if (!ws_.connected()) return;
  double f[30];
  const State& s = mixer_->state;
  for (int tries = 0; tries < 4; tries++) {
    const uint32_t a = s.seq.load(std::memory_order_acquire);
    if (a & 1) continue;
    f[0] = s.time.load(std::memory_order_relaxed);
    for (int k = 0; k < DECKS; k++) {
      f[5 + k * 5] = s.pos[k].load(std::memory_order_relaxed);
      f[6 + k * 5] = s.rate[k].load(std::memory_order_relaxed);
      f[7 + k * 5] = s.playing[k].load(std::memory_order_relaxed);
      f[8 + k * 5] = s.frames[k].load(std::memory_order_relaxed);
      f[9 + k * 5] = s.peak[k].load(std::memory_order_relaxed);
    }
    f[25] = s.master.load(std::memory_order_relaxed);
    std::atomic_thread_fence(std::memory_order_acquire);
    if (s.seq.load(std::memory_order_relaxed) == a) break;
  }
  f[1] = opened_.latency; f[2] = io.load.load(); f[3] = io.xruns.load(); f[4] = opened_.rate;
  for (int k = 0; k < DECKS; k++) f[26 + k] = s.ended[k].load(std::memory_order_relaxed);
  ws_.sendBinary(f, sizeof f);
}

}  // namespace

int selftest();  // selftest.cpp

int main(int argc, char** argv) {
  int port = 0;
  std::vector<std::string> origins;
  std::string record;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    if (a == "--selftest") return selftest();
    if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
    else if (a == "--origin" && i + 1 < argc) origins.push_back(argv[++i]);
    else if (a == "--record" && i + 1 < argc) record = argv[++i];
  }
  WsServer ws;
  const int bound = ws.listen(port, origins);
  if (!bound) { std::fprintf(stderr, "couldn't listen on port %d\n", port); return 1; }
  std::printf("PORT %d\n", bound); std::fflush(stdout);

  std::atomic<bool> quit{false};
  std::thread([&quit] { char b[256]; while (std::fread(b, 1, sizeof b, stdin) > 0) {} quit = true; }).detach();  // parent gone

  Engine engine(ws);
  engine.io.recordPath = record;
  auto last = std::chrono::steady_clock::now();
  while (!quit) {
    ws.poll(4, [&](const std::string& msg) {
      size_t a = 0;
      while (a < msg.size()) {
        size_t b = msg.find('\n', a); if (b == std::string::npos) b = msg.size();
        try { engine.command(msg.substr(a, b - a)); } catch (const std::exception& e) { ws.sendText(err("command", e.what())); }
        a = b + 1;
      }
    }, [&] {});
    const auto now = std::chrono::steady_clock::now();
    if (now - last >= std::chrono::milliseconds(10)) { last = now; engine.tick(); }
  }
  return 0;
}
