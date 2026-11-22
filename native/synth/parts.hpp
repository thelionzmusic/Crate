// Pieces every synth shares: envelopes and the state-variable filter.
#pragma once
#include "math.hpp"

namespace synth {

// attack rises in a straight line; decay and release fall exponentially, 99% of the way in their time
struct EnvShape {
  float up = 1, down = 0, out = 0, sustain = 1;
  void set(float a, float d, float s, float r, float sr) {
    up = 1.f / maxf(a * sr, 1.f);
    down = expf_(-4.6f / maxf(d * sr, 1.f));
    out = expf_(-4.6f / maxf(r * sr, 1.f));
    sustain = s;
  }
};
struct Env {
  enum Stage : uint8_t { IDLE, ATTACK, DECAY, RELEASE } stage = IDLE;
  float x = 0;
  void gate(bool on) { stage = on ? ATTACK : (stage == IDLE ? IDLE : RELEASE); }  // a new attack starts from where it is: no click
  float tick(const EnvShape& e) {
    switch (stage) {
      case ATTACK: x += e.up; if (x >= 1) { x = 1; stage = DECAY; } break;
      case DECAY: x = e.sustain + (x - e.sustain) * e.down; if (x < 1e-6f && e.sustain == 0) x = 0; break;  // no denormals: they're slow
      case RELEASE: x *= e.out; if (x < 1e-4f) { x = 0; stage = IDLE; } break;
      case IDLE: break;
    }
    return x;
  }
};

// Zavalishin's trapezoidal state-variable filter: stable at any setting, modulates cleanly
struct Svf {
  float ic1 = 0, ic2 = 0;
  // mode: 0 low, 1 band, 2 high, 3 notch
  float run(float x, float a1, float a2, float a3, float k, int mode) {
    const float v3 = x - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    switch (mode) { case 0: return v2; case 1: return v1; case 2: return x - k * v1 - v2; default: return x - k * v1; }
  }
};

}  // namespace synth
