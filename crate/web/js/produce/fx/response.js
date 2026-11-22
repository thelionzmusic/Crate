// Filter curves worked out from their coefficients, for the EQ and Auto Filter displays when
// the sound is rendered by the native engine: the same formulas as studio_fx.cpp, so the curve
// drawn is the one heard. Each Curve answers getFrequencyResponse like a Web Audio biquad.

const BW8 = [0.5098, 0.6013, 0.9, 2.5629];

export class Curve {
  constructor(sr) { this.sr = sr; this.set("none"); }

  set(type, f = 1000, q = 0.7071, g = 0) {
    this.type = type;
    if (type === "none") { [this.b0, this.b1, this.b2, this.a1, this.a2] = [1, 0, 0, 0, 0]; return; }
    f = Math.min(this.sr * 0.49, Math.max(5, f)); q = Math.max(q, 1e-3);
    const w = 2 * Math.PI * f / this.sr, c = Math.cos(w), s = Math.sin(w), A = 10 ** (g / 40), al = s / (2 * q), k = Math.sqrt(A) * s * Math.SQRT2;
    let b0, b1, b2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
    switch (type) {
      case "lp": b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; break;
      case "hp": b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; break;
      case "bp": b0 = al; b1 = 0; b2 = -al; break;
      case "notch": b0 = 1; b1 = -2 * c; b2 = 1; break;
      case "peak": b0 = 1 + al * A; b1 = -2 * c; b2 = 1 - al * A; a0 = 1 + al / A; a2 = 1 - al / A; break;
      case "lshelf":
        b0 = A * ((A + 1) - (A - 1) * c + k); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - k);
        a0 = (A + 1) + (A - 1) * c + k; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - k; break;
      case "hshelf":
        b0 = A * ((A + 1) + (A - 1) * c + k); b1 = -2 * A * ((A - 1) + (A + 1) * c); b2 = A * ((A + 1) + (A - 1) * c - k);
        a0 = (A + 1) - (A - 1) * c + k; a1 = 2 * ((A - 1) - (A + 1) * c); a2 = (A + 1) - (A - 1) * c - k; break;
      default: b0 = 1; b1 = b2 = 0;
    }
    [this.b0, this.b1, this.b2, this.a1, this.a2] = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }

  // |H| and its phase at each frequency: H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)
  getFrequencyResponse(freqs, mag, phase) {
    for (let i = 0; i < freqs.length; i++) {
      const w = 2 * Math.PI * freqs[i] / this.sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = this.b0 + this.b1 * c1 + this.b2 * c2, ni = -(this.b1 * s1 + this.b2 * s2);
      const dr = 1 + this.a1 * c1 + this.a2 * c2, di = -(this.a1 * s1 + this.a2 * s2), dd = dr * dr + di * di;
      const re = (nr * dr + ni * di) / dd, im = (ni * dr - nr * di) / dd;
      mag[i] = Math.hypot(re, im); phase[i] = Math.atan2(im, re);
    }
  }
}

const EQ_KIND = ["hp", "hp", "lshelf", "peak", "notch", "hshelf", "lp", "lp"];
const FILTER_KIND = ["lp", "hp", "bp", "notch"];

// a native device stand-in's curves, from its current values (v): EQ bands or filter stages
export function curves(inst, type, v, sr) {
  if (type === "eq") {
    inst.bands ||= Array.from({ length: 8 }, () => [0, 1, 2, 3].map(() => new Curve(sr)));
    inst.bands.forEach((fs, b) => {
      const n = b + 1, t = v[`t${n}`], cut4 = t === 0 || t === 7, gain = t === 2 || t === 3 || t === 5;
      fs.forEach((f, i) => (v[`on${n}`] && i < (cut4 ? 4 : 1) ? f.set(EQ_KIND[t], v[`f${n}`], cut4 ? BW8[i] : v[`q${n}`], gain ? v[`g${n}`] : 0) : f.set("none")));
    });
  } else if (type === "filter") {
    inst.filters ||= [new Curve(sr), new Curve(sr)];
    const kind = FILTER_KIND[v.type], steep = v.slope === 1;
    inst.filters[0].set(kind, v.freq, v.type < 2 && steep ? 0.5412 : v.res);
    if (steep) inst.filters[1].set(kind, v.freq, v.res); else inst.filters[1].set("none");
  }
}
