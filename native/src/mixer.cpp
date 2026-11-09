#include "mixer.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace crate {

namespace {
constexpr double XOVER_LO = 220, XOVER_HI = 2600;
constexpr double BUTTER = 0.7071067811865476;       // two of these in series = Linkwitz-Riley 4th order
constexpr double FILTER_Q = 1.1350;                 // engine.js uses Q 1.1 dB on the sweep filters
constexpr double TAU = 0.012;                       // control smoothing, as engine.js
constexpr double CEIL = 0.8912509381337456;         // -1 dBFS
}  // namespace

Mixer::Mixer(double sr) : sr_(sr) {
  for (auto& d : decks_) d.init(sr);
  const double init[NPARAMS] = {1, 1, 1, 1, 10, 22000, 1, 0, 1};
  for (auto& c : ch_) {
    for (int k = 0; k < NPARAMS; k++) c.p[k].init(sr, TAU, init[k]);
    for (auto& b : c.lo) b.set(Biquad::LP, XOVER_LO, BUTTER, sr);
    c.mid[0].set(Biquad::HP, XOVER_LO, BUTTER, sr); c.mid[1].set(Biquad::HP, XOVER_LO, BUTTER, sr);
    c.mid[2].set(Biquad::LP, XOVER_HI, BUTTER, sr); c.mid[3].set(Biquad::LP, XOVER_HI, BUTTER, sr);
    for (auto& b : c.hi) b.set(Biquad::HP, XOVER_HI, BUTTER, sr);
    for (auto& s : c.fx) s.init(sr);
    c.meter.init(sr);
  }
  const double mixInit[NMIX] = {1, 1, 0, 1};
  for (int k = 0; k < NMIX; k++) mix_[k].init(sr, TAU, mixInit[k]);
  limAtt_ = 1 - std::exp(-5.0 / LOOK);  // reaches the needed gain within the lookahead
  limRel_ = 1 - std::exp(-1 / (0.12 * sr));
  std::fill(std::begin(limNeed_), std::end(limNeed_), 1.0);
  masterMeter_.init(sr);
  for (int i = 0; i < DECKS; i++) { state.pos[i] = state.rate[i] = state.playing[i] = state.frames[i] = state.peak[i] = 0; state.ended[i] = 0; }
}

Mixer::~Mixer() {
  // the audio thread has stopped: everything still held is ours to free
  for (auto& d : decks_) delete d.unload();
  for (auto& c : ch_) for (auto& s : c.fx) delete s.swap(nullptr);
  Command c;
  while (commands.pop(c)) {
    if (c.op == Op::Load) delete static_cast<Pcm*>(c.ptr);
    if (c.op == Op::FxType) delete static_cast<Effect*>(c.ptr);
  }
}

void Mixer::apply(const Command& c) {
  Deck& d = decks_[c.deck % DECKS];
  switch (c.op) {
    case Op::Load: toss(Trash::PCM, d.load(static_cast<Pcm*>(c.ptr), c.a)); break;
    case Op::Unload: toss(Trash::PCM, d.unload()); break;
    case Op::Play: d.play(); break;
    case Op::Pause: d.pause(); break;
    case Op::Seek: d.seek(c.a); break;
    case Op::Rate: d.setRate(c.a, c.flag); break;
    case Op::Keylock: d.setKeylock(c.flag); break;
    case Op::Loop: if (c.flag) d.setLoop(c.a, c.b); else d.clearLoop(); break;
    case Op::Param: if (c.which < NPARAMS) ch_[c.deck % DECKS].p[c.which].set(c.a); break;
    case Op::Mix: if (c.which < NMIX) mix_[c.which].set(c.a); break;
    case Op::FxType: toss(Trash::FX, ch_[c.deck % DECKS].fx[c.slot & 1].swap(static_cast<Effect*>(c.ptr))); break;
    case Op::FxSet: ch_[c.deck % DECKS].fx[c.slot & 1].set(c.flag, c.a, FxParams{c.b, c.c, c.d, c.e}); break;
    case Op::Route: route_.external = c.flag; route_.masterAt = static_cast<int>(c.a); route_.phonesAt = static_cast<int>(c.b); break;
  }
}

void Mixer::render(float* out, int channels, int n) {
  Command c;
  while (commands.pop(c)) apply(c);
  std::memset(out, 0, sizeof(float) * static_cast<size_t>(channels) * n);
  for (int done = 0; done < n;) {
    const int m = std::min(CHUNK, n - done);
    chunk(m);
    float* o = out + static_cast<size_t>(done) * channels;
    auto put = [&](int at, const float* l, const float* r) {
      if (at < 0 || at + 1 >= channels) return;
      for (int i = 0; i < m; i++) { o[i * channels + at] = l[i]; o[i * channels + at + 1] = r[i]; }
    };
    if (route_.external) { for (int k = 0; k < DECKS; k++) put(2 * k, dL_[k], dR_[k]); }
    else { put(route_.masterAt, mL_, mR_); if (route_.phonesAt >= 0 && route_.phonesAt != route_.masterAt) put(route_.phonesAt, pL_, pR_); }
    done += m;
  }
  publish(n);
}

// one block of up to CHUNK frames through decks, channels and the master section
void Mixer::chunk(int n) {
  std::fill_n(mL_, n, 0.f); std::fill_n(mR_, n, 0.f); std::fill_n(cL_, n, 0.f); std::fill_n(cR_, n, 0.f);
  float L[CHUNK], R[CHUNK];
  for (int k = 0; k < DECKS; k++) {
    Deck& d = decks_[k];
    Channel& c = ch_[k];
    if (d.render(dL_[k], dR_[k], n)) state.ended[k].fetch_add(1, std::memory_order_relaxed);
    // sweep filters: coefficients move once per chunk; fully open means bypassed
    const double hpf = c.p[HPF].step(n), lpf = c.p[LPF].step(n);
    const bool hpOn = hpf > 12, lpOn = lpf < sr_ * 0.45 && lpf < 20000;
    if (hpOn) c.hpf.set(Biquad::HP, hpf, FILTER_Q, sr_); else c.hpf.reset();
    if (lpOn) c.lpf.set(Biquad::LP, lpf, FILTER_Q, sr_); else c.lpf.reset();
    for (int i = 0; i < n; i++) {
      const double trim = c.p[TRIM].next(), gl = c.p[LOW].next(), gm = c.p[MID].next(), gh = c.p[HIGH].next();
      for (int ch = 0; ch < 2; ch++) {
        const double x = (ch ? dR_[k][i] : dL_[k][i]) * trim;
        const double lo = c.lo[1].run(ch, c.lo[0].run(ch, x));
        const double mid = c.mid[3].run(ch, c.mid[2].run(ch, c.mid[1].run(ch, c.mid[0].run(ch, x))));
        const double hi = c.hi[1].run(ch, c.hi[0].run(ch, x));
        double y = lo * gl + mid * gm + hi * gh;
        if (hpOn) y = c.hpf.run(ch, y);
        if (lpOn) y = c.lpf.run(ch, y);
        (ch ? R : L)[i] = static_cast<float>(y);
      }
    }
    c.fx[0].process(L, R, n);
    c.fx[1].process(L, R, n);
    c.meter.block(L, R, n);
    for (int i = 0; i < n; i++) {
      const double cue = c.p[CUE].next(), g = c.p[FADER].next() * c.p[XF].next();
      cL_[i] += static_cast<float>(L[i] * cue); cR_[i] += static_cast<float>(R[i] * cue);
      mL_[i] += static_cast<float>(L[i] * g); mR_[i] += static_cast<float>(R[i] * g);
    }
  }
  // master: gain, then a fast limiter at -1 dBFS so nothing clips; headphones mix cue and master
  for (int i = 0; i < n; i++) {
    const double g = mix_[MASTER].next();
    const double inL = mL_[i] * g, inR = mR_[i] * g, env = std::max(std::fabs(inL), std::fabs(inR));
    limNeed_[limAt_] = env > CEIL ? CEIL / env : 1.0;
    double l = limBuf_[0][limAt_], r = limBuf_[1][limAt_];          // the sample from LOOK frames ago
    limBuf_[0][limAt_] = static_cast<float>(inL); limBuf_[1][limAt_] = static_cast<float>(inR);
    limAt_ = (limAt_ + 1) % LOOK;
    double want = 1;                                                 // lowest gain any sample in the window needs
    for (double v : limNeed_) want = std::min(want, v);
    limGain_ += (want - limGain_) * (want < limGain_ ? limAtt_ : limRel_);
    l = clampd(l * limGain_, -CEIL, CEIL); r = clampd(r * limGain_, -CEIL, CEIL);
    mL_[i] = static_cast<float>(l); mR_[i] = static_cast<float>(r);
    const double pc = mix_[PHONES_CUE].next(), pm = mix_[PHONES_MASTER].next(), pv = mix_[PHONES].next();
    pL_[i] = static_cast<float>(clampd((cL_[i] * pc + l * pm) * pv, -1, 1));
    pR_[i] = static_cast<float>(clampd((cR_[i] * pc + r * pm) * pv, -1, 1));
  }
  masterMeter_.block(mL_, mR_, n);
  clock_ += n;
}

void Mixer::publish(int) {
  auto& s = state;
  const uint32_t q = s.seq.load(std::memory_order_relaxed);
  s.seq.store(q + 1, std::memory_order_relaxed);
  std::atomic_thread_fence(std::memory_order_release);
  s.time.store(static_cast<double>(clock_) / sr_, std::memory_order_relaxed);
  for (int k = 0; k < DECKS; k++) {
    const Deck& d = decks_[k];
    s.pos[k].store(d.pos(), std::memory_order_relaxed);
    s.rate[k].store(d.rate(), std::memory_order_relaxed);
    s.playing[k].store(d.playing() ? 1 : 0, std::memory_order_relaxed);
    s.frames[k].store(static_cast<double>(d.frames()), std::memory_order_relaxed);
    s.peak[k].store(ch_[k].meter.v, std::memory_order_relaxed);
  }
  s.master.store(masterMeter_.v, std::memory_order_relaxed);
  s.seq.store(q + 2, std::memory_order_release);
}

}  // namespace crate
