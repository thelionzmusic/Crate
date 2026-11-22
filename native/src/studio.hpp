// Production's sound, native: tracks, returns and Main, each a strip (input, devices, volume,
// pan, meter); post-fader sends into the returns; clip voices started and stopped on exact
// frames. The page keeps the set and the timing; this renders it. See web/js/produce/out-native.js.
//
// Threads, as in the mixer: the control thread parses commands, builds strips, devices and
// buffers, and publishes the routing as an immutable Graph. The audio thread (StudioCore::render,
// called from inside the mixer before its master section) only swaps graphs, sets parameters
// and renders; whatever it lets go of comes back through a queue to be freed.
#pragma once
#include <array>
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "deck.hpp"
#include "dsp.hpp"
#include "mixer.hpp"
#include "studio_fx.hpp"

namespace crate {

constexpr int RETURNS = 12;  // A to L
constexpr int VOICES = 256;

struct Strip {
  explicit Strip(double sr);
  Smooth gain, pan;
  std::array<Smooth, RETURNS> send;
  float L[CHUNK], R[CHUNK];
  PeakFall meter;
  std::atomic<double> peak{0};
};

// who plays into whom, swapped whole; the audio thread never changes one. Tracks are in
// render order: a group comes after everything that plays into it.
struct Graph {
  struct Node { Strip* s = nullptr; std::vector<Device*> chain; Strip* out = nullptr; };  // out: a group's strip, or null for Main
  std::vector<Node> tracks, returns;
  std::array<Strip*, RETURNS> byLetter{};
  Node main;
  // set by the control thread before the next swap: freed with this graph, once nothing uses it
  std::vector<Strip*> deadStrips;
  std::vector<Device*> deadDevices;
  ~Graph();
};

struct Voice {
  int id = 0;
  bool on = false, preview = false;
  Strip* to = nullptr;
  Pcm* buf = nullptr;
  long long start = 0, stop = -1;   // engine frames; stop -1 means at the end
  double pos = 0, rate = 1, end = 0;  // in the buffer's frames
  int fade = -1;                     // frames left of a stop's fade-out, -1 while not stopping
};

enum class SOp : uint8_t { Graph, Level, Send, Param, Tempo, Play, Stop, StopAll, Unbuf };
struct SCmd { SOp op; void* ptr = nullptr; void* ptr2 = nullptr; int i = 0; double a = 0, b = 0, c = 0, d = 0; long long f = 0; bool flag = false; };
struct STrash { enum Kind : uint8_t { GRAPH, PCM } kind; void* ptr; };

class StudioCore {
 public:
  explicit StudioCore(double sr) : sr(sr) {}
  // audio thread: add n frames (n <= CHUNK) of the studio into L and R; `clock` is the frame at L[0]
  void render(float* L, float* R, int n, long long clock);
  Queue<SCmd, 8192> commands;
  Queue<STrash, 1024> trash;
  const double sr;
  Graph* graph = nullptr;  // the audio thread's; read by the control thread only once audio has stopped

 private:
  void apply(const SCmd& c, long long clock);
  void voices(int n, long long clock, float* pvL, float* pvR);
  std::array<Voice, VOICES> voice_{};
};

// The control side: commands from the page ("s ..." lines), loads, meters out.
class StudioControl {
 public:
  using Send = std::function<void(const std::string&)>;
  explicit StudioControl(Send send) : send_(std::move(send)) {}
  ~StudioControl() { reset(); }
  void command(std::istringstream& in, Mixer& m);  // the line after its "s"
  void flush();                                    // publish routing changed by the last commands
  void tick(Mixer* m);                             // finished loads, freed memory, meters out
  void reset();                                    // the output closed: everything goes (audio has stopped)

 private:
  struct Owned { std::unique_ptr<Strip> s; char kind = 't'; int letter = -1; bool leveled = false; std::string out = "main"; std::vector<std::pair<int, bool>> chain; };
  struct Dev { std::unique_ptr<Device> d; std::string type; };
  struct Loaded { int id; Pcm* pcm; std::string error; int generation; };
  void push(const SCmd& c);
  void attach(Mixer& m);
  void freeGraph(Graph* g);
  Strip* strip(const std::string& key) { auto it = strips_.find(key); return it == strips_.end() ? nullptr : it->second.s.get(); }

  Send send_;
  std::unique_ptr<StudioCore> core_;
  std::map<std::string, Owned> strips_;
  std::map<int, Dev> devices_;
  std::set<int> fresh_;              // devices not yet published: the control thread may still set them directly
  std::map<int, Pcm*> buffers_;
  std::vector<Strip*> orphans_;      // dropped strips, until the audio thread has moved on from them
  Graph* live_ = nullptr;            // the last graph published
  bool dirty_ = false;
  double bpm_ = 120;
  int generation_ = 0, ticks_ = 0;
  std::mutex doneM_;
  std::vector<Loaded> done_;
  std::vector<std::thread> loaders_;
};

}  // namespace crate
