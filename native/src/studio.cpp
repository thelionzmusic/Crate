// Production's sound, native. See studio.hpp for how the threads share it.
#include "studio.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>

#include "text.hpp"

namespace crate {

namespace {
bool inGraph(const Graph* g, const Strip* s) {
  for (const auto& t : g->tracks) if (t.s == s) return true;
  return false;
}
}  // namespace

Strip::Strip(double sr) {
  gain.init(sr, 0.01, 0); pan.init(sr, 0.01, 0);
  for (auto& s : send) s.init(sr, 0.01, 0);
  meter.init(sr);
  std::fill_n(L, CHUNK, 0.f); std::fill_n(R, CHUNK, 0.f);
}

Graph::~Graph() {
  for (auto* s : deadStrips) delete s;
  for (auto* d : deadDevices) delete d;
}

// ---------------------------------------------------------------- audio thread

void StudioCore::apply(const SCmd& c, long long clock) {
  switch (c.op) {
    case SOp::Graph: {
      Graph* old = graph;
      graph = static_cast<Graph*>(c.ptr);
      for (auto& v : voice_) if (v.on && !v.preview && !inGraph(graph, v.to)) v.on = false;  // its track went
      for (auto& x : note_) if (x.state != Note::FREE && !inGraph(graph, x.to)) x.state = Note::FREE;
      if (old) {  // an instrument taken out of the chain lets go of its notes, so none hang when it's back
        auto inNew = [&](Device* d) {
          for (auto* nodes : {&graph->tracks, &graph->returns}) for (auto& n : *nodes) for (auto* e : n.chain) if (e == d) return true;
          return false;
        };
        for (auto& n : old->tracks) for (auto* d : n.chain) if (d->instrument() && !inNew(d)) d->instrument()->releaseAll();
      }
      if (old && !trash.push({STrash::GRAPH, old})) { /* full: leaks rather than block */ }
      break;
    }
    case SOp::Level: {
      auto* s = static_cast<Strip*>(c.ptr);
      if (c.flag) { s->gain.jump(c.a); s->pan.jump(c.b); } else { s->gain.set(c.a); s->pan.set(c.b); }
      break;
    }
    case SOp::Send: static_cast<Strip*>(c.ptr)->send[c.i % RETURNS].set(c.a); break;
    case SOp::Param: static_cast<Device*>(c.ptr)->set(c.i, c.a); break;
    case SOp::Tempo:
      if (graph) {
        for (auto* nodes : {&graph->tracks, &graph->returns}) for (auto& n : *nodes) for (auto* d : n.chain) d->tempo(c.a);
        for (auto* d : graph->main.chain) d->tempo(c.a);
      }
      break;
    case SOp::Play:
      for (auto& v : voice_) {
        if (v.on) continue;
        v = Voice{};
        v.id = c.i; v.on = true; v.preview = c.flag; v.to = static_cast<Strip*>(c.ptr); v.buf = static_cast<Pcm*>(c.ptr2);
        v.start = c.f; v.pos = c.a; v.rate = c.b; v.end = c.c;
        break;
      }
      break;
    case SOp::Note:
      for (auto& x : note_) {
        if (x.state != Note::FREE) continue;
        x = Note{c.i, static_cast<int>(c.a), static_cast<float>(c.b), static_cast<Strip*>(c.ptr), c.f, static_cast<long long>(c.c), Note::WAITING};
        break;
      }
      break;
    case SOp::Stop:
      for (auto& v : voice_) if (v.on && v.id == c.i) v.stop = c.f;
      for (auto& x : note_) if (x.state != Note::FREE && x.id == c.i) { if (x.state == Note::WAITING && c.f <= x.on) x.state = Note::FREE; else x.off = std::min(x.off, c.f); }
      break;
    case SOp::StopAll:
      for (auto& v : voice_) if (v.on && (!c.flag || v.preview)) v.stop = clock;
      if (!c.flag) for (auto& x : note_) { if (x.state == Note::WAITING) x.state = Note::FREE; else if (x.state == Note::SOUNDING) x.off = std::min(x.off, clock); }
      break;
    case SOp::Unbuf:
      for (auto& v : voice_) if (v.buf == c.ptr) v.on = false;
      if (!trash.push({STrash::PCM, c.ptr})) { /* full: leaks rather than block */ }
      break;
  }
}

// every playing voice into its track's input (or the preview bus), from its start frame;
// a stop fades over 5 ms rather than clicking
void StudioCore::voices(int n, long long clock, float* pvL, float* pvR) {
  const int fadeLen = static_cast<int>(sr * 0.005);
  for (auto& v : voice_) {
    if (!v.on) continue;
    float* toL = v.preview ? pvL : v.to->L;
    float* toR = v.preview ? pvR : v.to->R;
    const int16_t* d = v.buf->data.data();
    const long long last = v.buf->frames - 1;
    const double end = std::min(v.end, static_cast<double>(last));
    for (int i = 0; i < n; i++) {
      const long long at = clock + i;
      if (at < v.start) continue;
      if (v.stop >= 0 && at >= v.stop && v.fade < 0) v.fade = fadeLen;
      if (v.pos >= end || v.fade == 0) { v.on = false; break; }
      double g = 1.0 / 32768;
      if (v.fade > 0) g *= static_cast<double>(v.fade--) / fadeLen;
      const long long k = static_cast<long long>(v.pos);
      const double f = v.pos - static_cast<double>(k);
      double l, r;
      if (f == 0) { l = d[k * 2]; r = d[k * 2 + 1]; }
      else {  // cubic Hermite between the four nearest frames
        const long long k0 = std::max(0LL, k - 1), k2 = std::min(last, k + 1), k3 = std::min(last, k + 2);
        auto hermite = [&](int ch) {
          const double a0 = d[k0 * 2 + ch], a1 = d[k * 2 + ch], a2 = d[k2 * 2 + ch], a3 = d[k3 * 2 + ch];
          const double c1 = 0.5 * (a2 - a0), c2 = a0 - 2.5 * a1 + 2 * a2 - 0.5 * a3, c3 = 0.5 * (a3 - a0) + 1.5 * (a1 - a2);
          return ((c3 * f + c2) * f + c1) * f + a1;
        };
        l = hermite(0); r = hermite(1);
      }
      toL[i] += static_cast<float>(l * g); toR[i] += static_cast<float>(r * g);
      v.pos += v.rate;
    }
  }
}

// each track's notes due in this block go to its instrument as events at their frames; notes
// for a track with no instrument just lapse
void StudioCore::notes(const Graph& g, int n, long long clock) {
  const long long end = clock + n;
  for (const auto& t : g.tracks) {
    Instrument* inst = nullptr;
    for (auto* d : t.chain) if ((inst = d->instrument())) break;
    if (!inst) continue;
    for (auto& x : note_) {
      if (x.state == Note::FREE || x.to != t.s) continue;
      if (x.state == Note::WAITING && x.on < end) { inst->note(static_cast<int>(std::max(0LL, x.on - clock)), x.id, x.pitch, x.vel, true); x.state = Note::SOUNDING; }
      if (x.state == Note::SOUNDING && x.off < end) { inst->note(static_cast<int>(std::max(0LL, x.off - clock)), x.id, x.pitch, x.vel, false); x.state = Note::FREE; }
    }
  }
  for (auto& x : note_) if (x.state != Note::FREE && x.off < end) x.state = Note::FREE;
}

void StudioCore::render(float* L, float* R, int n, long long clock) {
  SCmd c;
  while (commands.pop(c)) apply(c, clock);
  Graph* g = graph;
  if (!g) return;
  auto clear = [n](Strip* s) { std::fill_n(s->L, n, 0.f); std::fill_n(s->R, n, 0.f); };
  for (auto& t : g->tracks) clear(t.s);
  for (auto& r : g->returns) clear(r.s);
  if (g->main.s) clear(g->main.s);
  float pvL[CHUNK] = {}, pvR[CHUNK] = {};
  voices(n, clock, pvL, pvR);
  notes(*g, n, clock);

  float* outL = g->main.s ? g->main.s->L : L;
  float* outR = g->main.s ? g->main.s->R : R;
  // fader and pan in place (Web Audio's stereo panner), meter, then into `toL/toR` and the sends
  auto finish = [&](Strip* s, float* toL, float* toR, bool sends) {
    const double p = s->pan.step(n), x = p <= 0 ? p + 1 : p, gl = std::cos(x * PI / 2), gr = std::sin(x * PI / 2);
    for (int i = 0; i < n; i++) {
      const double gain = s->gain.next(), l = s->L[i] * gain, r = s->R[i] * gain;
      s->L[i] = static_cast<float>(p <= 0 ? l + r * gl : l * gl);
      s->R[i] = static_cast<float>(p <= 0 ? r * gr : r + l * gr);
    }
    s->meter.block(s->L, s->R, n);
    s->peak.store(s->meter.v, std::memory_order_relaxed);
    for (int i = 0; i < n; i++) { toL[i] += s->L[i]; toR[i] += s->R[i]; }
    if (!sends) return;
    for (int k = 0; k < RETURNS; k++) {
      Strip* to = g->byLetter[k];
      Smooth& sg = s->send[k];
      if (!to || (sg.target == 0 && sg.v < 1e-6)) continue;
      for (int i = 0; i < n; i++) { const double a = sg.next(); to->L[i] += static_cast<float>(s->L[i] * a); to->R[i] += static_cast<float>(s->R[i] * a); }
    }
  };
  for (auto& t : g->tracks) { for (auto* d : t.chain) d->process(t.s->L, t.s->R, n); finish(t.s, t.out ? t.out->L : outL, t.out ? t.out->R : outR, true); }
  for (auto& r : g->returns) { for (auto* d : r.chain) d->process(r.s->L, r.s->R, n); finish(r.s, outL, outR, false); }
  if (Strip* m = g->main.s) {
    for (auto* d : g->main.chain) d->process(m->L, m->R, n);
    for (int i = 0; i < n; i++) { m->L[i] += pvL[i]; m->R[i] += pvR[i]; }  // previews skip Main's devices, not its fader
    finish(m, L, R, false);
  } else {
    for (int i = 0; i < n; i++) { L[i] += pvL[i]; R[i] += pvR[i]; }
  }
}

// ---------------------------------------------------------------- control thread

void StudioControl::push(const SCmd& c) { if (core_ && !core_->commands.push(c)) send_(err("studio", "Engine is busy")); }

void StudioControl::attach(Mixer& m) {
  if (core_) return;
  core_ = std::make_unique<StudioCore>(m.sampleRate());
  m.studio.store(core_.get(), std::memory_order_release);
}

void StudioControl::command(std::istringstream& in, Mixer& m) {
  attach(m);
  const double sr = core_->sr;
  std::string cmd, key;
  in >> cmd;
  if (cmd == "strip") {  // strip <key> <t|r|m> [letter]
    char kind = 't'; int letter = -1;
    in >> key >> kind >> letter;
    if (key.empty() || strips_.count(key)) return;
    Owned o; o.s = std::make_unique<Strip>(sr); o.kind = kind; o.letter = kind == 'r' && letter >= 0 && letter < RETURNS ? letter : -1;
    strips_.emplace(key, std::move(o));
    dirty_ = true;
  } else if (cmd == "drop") {  // drop <key>: its devices go too, unless another strip has them
    in >> key;
    auto it = strips_.find(key);
    if (it == strips_.end()) return;
    orphans_.push_back(it->second.s.release());  // Level and Send commands may still be queued for it
    strips_.erase(it);
    dirty_ = true;
  } else if (cmd == "level") {  // level <key> <gain> <pan>
    SCmd c{SOp::Level}; in >> key >> c.a >> c.b;
    auto it = strips_.find(key);
    if (it == strips_.end()) return;
    c.ptr = it->second.s.get(); c.flag = !it->second.leveled; it->second.leveled = true;
    push(c);
  } else if (cmd == "route") {  // route <key> <key of the group it plays into, or main>
    std::string to; in >> key >> to;
    auto it = strips_.find(key);
    if (it == strips_.end() || to == key) return;
    it->second.out = to;
    dirty_ = true;
  } else if (cmd == "send") {  // send <key> <letter> <gain>
    SCmd c{SOp::Send}; in >> key >> c.i >> c.a;
    if (Strip* s = strip(key); s && c.i >= 0 && c.i < RETURNS) { c.ptr = s; push(c); }
  } else if (cmd == "chain") {  // chain <key> <id:type:on,...> or "-" for none
    std::string spec; in >> key >> spec;
    auto it = strips_.find(key);
    if (it == strips_.end()) return;
    std::vector<std::pair<int, bool>> chain;
    std::istringstream items(spec == "-" ? "" : spec);
    for (std::string item; std::getline(items, item, ',');) {
      const size_t a = item.find(':'), b = item.rfind(':');
      if (a == std::string::npos || b == a) continue;
      const int id = std::atoi(item.substr(0, a).c_str());
      const std::string type = item.substr(a + 1, b - a - 1);
      if (!devices_.count(id)) {
        auto d = makeDevice(type, sr);
        if (!d) { send_(err("chain", "Unknown effect " + type)); continue; }
        d->tempo(bpm_);
        devices_[id] = Dev{std::move(d), type};
        fresh_.insert(id);
      }
      chain.emplace_back(id, item.substr(b + 1) != "0");
    }
    it->second.chain = std::move(chain);
    dirty_ = true;
  } else if (cmd == "p") {  // p <device id> <param> <value>
    int id = 0; double v = 0; in >> id >> key >> v;
    auto it = devices_.find(id);
    if (it == devices_.end()) return;
    const int k = paramIndex(it->second.type, key);
    if (k < 0) return;
    if (fresh_.count(id)) it->second.d->set(k, v);  // not on the audio thread yet
    else { SCmd c{SOp::Param}; c.ptr = it->second.d.get(); c.i = k; c.a = v; push(c); }
  } else if (cmd == "tempo") {
    in >> bpm_;
    for (int id : fresh_) devices_[id].d->tempo(bpm_);
    SCmd c{SOp::Tempo}; c.a = bpm_; push(c);
  } else if (cmd == "buf") {  // buf <id> <path to raw 16-bit stereo at the engine's rate, to the end of the line>
    int id = 0; in >> id;
    std::string path; std::getline(in >> std::ws, path);
    const int gen = generation_;
    loaders_.emplace_back([this, id, path, gen] {
      Loaded r{id, nullptr, "", gen};
      std::ifstream f(std::filesystem::u8path(path), std::ios::binary | std::ios::ate);
      if (!f) r.error = "Couldn't read the decoded sound";
      else {
        auto* p = new Pcm();
        p->frames = static_cast<long long>(f.tellg()) / 4;
        p->data.resize(static_cast<size_t>(p->frames) * 2);
        f.seekg(0);
        f.read(reinterpret_cast<char*>(p->data.data()), static_cast<std::streamsize>(p->frames * 4));
        r.pcm = p;
      }
      std::lock_guard<std::mutex> g(doneM_);
      done_.push_back(std::move(r));
    });
  } else if (cmd == "unbuf") {
    int id = 0; in >> id;
    auto it = buffers_.find(id);
    if (it == buffers_.end()) return;
    SCmd c{SOp::Unbuf}; c.ptr = it->second;
    buffers_.erase(it);
    if (!core_->commands.push(c)) delete static_cast<Pcm*>(c.ptr);  // full: nothing can be playing it yet anyway
  } else if (cmd == "play") {  // play <voice id> <key|preview> <buffer id> <when s> <from s> <rate> <length s, -1 for all>
    SCmd c{SOp::Play}; int buf = 0; double when = 0, from = 0, rate = 1, len = -1;
    in >> c.i >> key >> buf >> when >> from >> rate >> len;
    auto b = buffers_.find(buf);
    if (b == buffers_.end()) { send_(err("play", "That sound isn't loaded")); return; }
    flush();  // a new track must be on the audio thread before its first voice
    c.flag = key == "preview";
    if (!c.flag) { c.ptr = strip(key); if (!c.ptr) return; }
    c.ptr2 = b->second;
    c.f = std::llround(when * sr); c.a = from * sr; c.b = rate > 0 ? rate : 1;
    c.c = len < 0 ? static_cast<double>(b->second->frames) : std::min(static_cast<double>(b->second->frames), c.a + len * sr);
    push(c);
  } else if (cmd == "note") {  // note <id> <key> <pitch> <velocity 0-1> <when s> <length s>
    SCmd c{SOp::Note}; double when = 0, len = 0;
    in >> c.i >> key >> c.a >> c.b >> when >> len;
    flush();
    c.ptr = strip(key);
    if (!c.ptr) return;
    c.f = std::llround(when * sr); c.c = static_cast<double>(c.f + std::max(1LL, std::llround(len * sr)));
    push(c);
  } else if (cmd == "stop") {  // stop <voice or note id> <when s>
    SCmd c{SOp::Stop}; double when = 0; in >> c.i >> when; c.f = std::llround(when * sr); push(c);
  } else if (cmd == "stopall") {  // stopall [preview]
    SCmd c{SOp::StopAll}; in >> key; c.flag = key == "preview"; push(c);
  } else {
    send_(err("s", "Unknown studio command " + cmd));
  }
}

void StudioControl::flush() {
  if (!dirty_ || !core_) return;
  auto* g = new Graph();
  std::set<int> used;
  // how many groups a track plays through before Main (a broken or looping route counts as none)
  auto depth = [this](const Owned& o) {
    int d = 0;
    for (const Owned* at = &o; d < 64; d++) {
      auto up = strips_.find(at->out);
      if (up == strips_.end() || up->second.kind != 't') break;
      at = &up->second;
    }
    return d < 64 ? d : 0;
  };
  std::vector<std::pair<int, Graph::Node>> tracks;
  for (auto& [key, o] : strips_) {
    Graph::Node node{o.s.get(), {}, nullptr};
    if (auto up = strips_.find(o.out); o.kind == 't' && up != strips_.end() && up->second.kind == 't') node.out = up->second.s.get();
    for (const auto& [id, isOn] : o.chain) {
      auto it = devices_.find(id);
      if (it == devices_.end()) continue;
      used.insert(id);
      if (isOn) node.chain.push_back(it->second.d.get());
    }
    if (o.kind == 'm') g->main = node;
    else if (o.kind == 'r') { g->returns.push_back(node); if (o.letter >= 0) g->byLetter[o.letter] = node.s; }
    else tracks.emplace_back(depth(o), node);
  }
  std::stable_sort(tracks.begin(), tracks.end(), [](const auto& a, const auto& b) { return a.first > b.first; });  // deepest first
  for (auto& [d, node] : tracks) g->tracks.push_back(node);
  // devices no strip has any more: never published ones go now; the rest once the audio thread lets go
  for (auto it = devices_.begin(); it != devices_.end();) {
    if (used.count(it->first)) { ++it; continue; }
    Device* d = it->second.d.release();
    if (fresh_.count(it->first)) delete d; else (live_ ? live_->deadDevices : g->deadDevices).push_back(d);
    fresh_.erase(it->first);
    it = devices_.erase(it);
  }
  // dropped strips: freed with the graph the audio thread lets go of next (their commands are queued before it)
  for (Strip* s : orphans_) (live_ ? live_->deadStrips : g->deadStrips).push_back(s);
  orphans_.clear();
  SCmd c{SOp::Graph}; c.ptr = g;
  if (!core_->commands.push(c)) {  // full: try again next tick
    orphans_.swap(g->deadStrips);
    for (Device* d : g->deadDevices) delete d;  // only fresh or never-used could be here
    g->deadDevices.clear();
    delete g;
    return;
  }
  live_ = g; fresh_.clear(); dirty_ = false;
}

void StudioControl::tick(Mixer* m) {
  std::vector<Loaded> ready;
  { std::lock_guard<std::mutex> g(doneM_); ready.swap(done_); }
  for (auto& r : ready) {
    if (r.generation != generation_) { delete r.pcm; continue; }
    if (!r.error.empty()) { send_("{\"type\":\"error\",\"what\":\"sbuf\",\"id\":" + std::to_string(r.id) + ",\"message\":\"" + esc(r.error) + "\"}"); continue; }
    if (auto old = buffers_.find(r.id); old != buffers_.end()) { SCmd c{SOp::Unbuf}; c.ptr = old->second; push(c); }
    buffers_[r.id] = r.pcm;
    send_("{\"type\":\"sbuf\",\"id\":" + std::to_string(r.id) + ",\"frames\":" + std::to_string(r.pcm->frames) + "}");
  }
  if (!ready.empty() || loaders_.size() > 8) { for (auto& t : loaders_) if (t.joinable()) t.join(); loaders_.clear(); }
  if (!core_ || !m) return;
  flush();
  STrash t;
  while (core_->trash.pop(t)) { if (t.kind == STrash::GRAPH) delete static_cast<Graph*>(t.ptr); else delete static_cast<Pcm*>(t.ptr); }
  if (++ticks_ % 3) return;  // meters about 30 times a second
  std::string s = "{\"type\":\"studio\",\"s\":{", d;
  char b[96];
  bool first = true;
  for (auto& [key, o] : strips_) { std::snprintf(b, sizeof b, "%s\"%s\":%.4f", first ? "" : ",", key.c_str(), o.s->peak.load(std::memory_order_relaxed)); s += b; first = false; }
  for (auto& [id, dev] : devices_) {
    if (dev.type != "comp" && dev.type != "gate" && dev.type != "limiter") continue;
    std::snprintf(b, sizeof b, "%s\"%d\":%.2f", d.empty() ? "" : ",", id, dev.d->meter.load(std::memory_order_relaxed));
    d += b;
  }
  send_(s + "},\"d\":{" + d + "}}");
}

void StudioControl::reset() {
  generation_++;
  std::set<Graph*> graphs;
  std::set<Pcm*> pcms;
  if (core_) {  // what the audio thread held, had queued, or let go of
    if (core_->graph) graphs.insert(core_->graph);
    SCmd c;
    while (core_->commands.pop(c)) { if (c.op == SOp::Graph) graphs.insert(static_cast<Graph*>(c.ptr)); if (c.op == SOp::Unbuf) pcms.insert(static_cast<Pcm*>(c.ptr)); }
    STrash t;
    while (core_->trash.pop(t)) { if (t.kind == STrash::GRAPH) graphs.insert(static_cast<Graph*>(t.ptr)); else pcms.insert(static_cast<Pcm*>(t.ptr)); }
    core_.reset();
  }
  if (live_) graphs.insert(live_);
  for (Graph* g : graphs) delete g;
  for (Pcm* p : pcms) delete p;
  for (Strip* s : orphans_) delete s;
  for (auto& [id, p] : buffers_) delete p;
  live_ = nullptr; orphans_.clear(); buffers_.clear(); strips_.clear(); devices_.clear(); fresh_.clear(); dirty_ = false;
  for (auto& t : loaders_) if (t.joinable()) t.join();
  loaders_.clear();
  for (auto& r : done_) delete r.pcm;
  done_.clear();
}

}  // namespace crate
