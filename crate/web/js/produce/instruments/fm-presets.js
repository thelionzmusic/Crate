// Crate FM's factory sounds, by kind. Each holds only what differs from the defaults. Levels are
// balanced so that switching between them doesn't jump in volume (tests/web/instruments.js
// renders every one and checks it).
//
// The organs follow a drawbar organ's footages: 16' is the sub, 8' ratio 1, 5⅓' ratio 1.5,
// 4' ratio 2, 2⅔' ratio 3, 2' ratio 4. Percussion is an operator that decays to nothing; the
// rotary speaker is LFO 1 on pan and, very slightly, pitch.

// shared parts
const SAW = 2, SQUARE = 3, PULSE = 4, VOWEL = 5, TRI = 1;
const LP24 = 2, LP12 = 1, HP12 = 3;
const mono = { mono: 2, glide: 0.04 };
const pluckAmp = (d = 0.4, r = 0.25) => ({ aa: 0, ad: d, as: 0, ar: r });
const vibrato = (amt = 0.006, rate = 5.5) => ({ m6src: 1, m6dst: 0, m6amt: amt, l1rate: rate, l1trig: false });
const saws = (uni, detune, spread = 0.9) => ({ awave: SAW, blevel: 0, uni, detune, spread });
const sync = (lfo, div, shape = 0) => ({ [`l${lfo}sync`]: true, [`l${lfo}div`]: div, [`l${lfo}shape`]: shape });
const DIV = { bar: 2, "1/2": 3, "1/4": 5, "1/4T": 6, "1/8": 7, "1/8T": 8, "1/16": 9, "1/16T": 10 };
const organ = (bars, extra = {}) => ({ algo: 7, aa: 0.005, ad: 0.3, as: 1, ar: 0.05, vel: 0, ...bars, ...extra });
const leslie = (rate) => ({ l1rate: rate, l1trig: false, m5src: 1, m5dst: 9, m5amt: 0.3, m6src: 1, m6dst: 0, m6amt: 0.0015 });
const eight08 = (extra = {}) => ({ blevel: 0, mono: 1, aa: 0, ad: 2.5, as: 0, ar: 0.3, ma: 0, md: 0.08, ms: 0, m1src: 3, m1dst: 0, m1amt: 0.12, dist: 0.25, vel: 0.3, ...extra });
const growl = (extra = {}) => ({ ...mono, glide: 0.03, ftype: LP24, l1trig: true, ...extra });

export const FM_PRESETS = {
  Plucks: {
    "Glass Pluck": { bratio: 3, blevel: 0.55, batt: 0, bdec: 0.18, bsus: 0, brel: 0.1, bvel: 0.5, ...pluckAmp(0.6, 0.3), level: 0.57 },
    "Soft Pluck": { awave: TRI, blevel: 0.4, bdec: 0.25, bsus: 0, ftype: LP12, cutoff: 4000, fenv: 0.25, md: 0.2, ...pluckAmp(0.45), level: 0.94 },
    "Future Pluck": { ...saws(5, 0.3, 0.8), ftype: LP24, cutoff: 600, res: 0.25, fenv: 0.55, md: 0.22, ...pluckAmp(0.4, 0.3), dist: 0.15, level: 0.53 },
    "Kalimba": { bratio: 4, blevel: 0.3, bdec: 0.08, bsus: 0, ...pluckAmp(0.9, 0.5), level: 0.52 },
    "Harp": { bratio: 2, blevel: 0.25, bdec: 0.5, bsus: 0, ...pluckAmp(1.6, 1), level: 0.38 },
    "Marimba": { bratio: 4, blevel: 0.35, bdec: 0.05, bsus: 0, ...pluckAmp(0.5, 0.3), level: 0.61 },
    "Pizzicato": { ...saws(2, 0.1, 0.4), ftype: LP24, cutoff: 900, fenv: 0.35, md: 0.12, ...pluckAmp(0.25, 0.2), level: 0.93 },
    "Bell Pluck": { bratio: 3.5, blevel: 0.4, bdec: 0.7, bsus: 0, ...pluckAmp(1.2, 0.8), level: 0.49 },
    "Trance Pluck": { ...saws(7, 0.4, 1), ftype: LP24, cutoff: 400, res: 0.35, fenv: 0.6, md: 0.18, ...pluckAmp(0.3, 0.35), level: 0.51 },
    "Square Pluck": { awave: SQUARE, blevel: 0, ftype: LP12, cutoff: 1500, fenv: 0.4, md: 0.15, ...pluckAmp(0.3, 0.2), level: 0.63 },
    "Koto": { bratio: 3, blevel: 0.5, bdec: 0.12, bsus: 0.1, bfb: 0.2, ...pluckAmp(0.9, 0.4), level: 0.52 },
    "Water Drop": { blevel: 0.2, m1src: 3, m1dst: 0, m1amt: 0.15, md: 0.05, ...pluckAmp(0.25, 0.2), level: 0.94 },
    "Tropical Pluck": { awave: TRI, bratio: 2, blevel: 0.4, bdec: 0.15, bsus: 0, ftype: LP24, cutoff: 4000, ...pluckAmp(0.3, 0.15), level: 0.72 },
    "Digital Pluck": { awave: PULSE, bratio: 2, blevel: 0.35, bdec: 0.1, bsus: 0, ftype: LP24, cutoff: 5000, ...pluckAmp(0.45, 0.2), level: 1 },
  },
  Leads: {
    "Supersaw Lead": { ...saws(7, 0.35), ftype: LP24, cutoff: 8000, aa: 0.005, ...mono, level: 0.3 },
    "Square Lead": { awave: SQUARE, blevel: 0, uni: 3, detune: 0.15, ftype: LP12, cutoff: 5000, ...mono, glide: 0.06, ...vibrato(), level: 0.21 },
    "FM Lead": { bratio: 2, blevel: 0.5, bdec: 0.5, bsus: 0.6, ...mono, glide: 0.05, ...vibrato(), level: 0.33 },
    "Sync Lead": { awave: SAW, bratio: 2, blevel: 0.45, fm: 0.6, m1src: 3, m1dst: 3, m1amt: 0.4, md: 0.3, ms: 0, ftype: LP24, cutoff: 9000, ...mono, level: 0.57 },
    "Chip Lead": { awave: PULSE, blevel: 0, mono: 1, vel: 0, ...vibrato(0.01, 6), level: 0.48 },
    "Hoover Lead": { ...saws(7, 0.6, 1), sub: 0.3, ...mono, glide: 0.15, m1src: 3, m1dst: 0, m1amt: -0.05, md: 0.2, ms: 0, dist: 0.2, level: 0.45 },
    "Whistle": { blevel: 0.1, noise: 0.03, aa: 0.04, ...vibrato(0.006, 5), ...mono, level: 0.42 },
    "Brass Lead": { awave: SAW, blevel: 0.3, batt: 0.08, ftype: LP24, cutoff: 1800, fenv: 0.3, ma: 0.06, md: 0.4, ms: 0.5, aa: 0.03, ...mono, level: 0.45 },
    "Acid Lead": { awave: SAW, blevel: 0, ftype: LP24, cutoff: 500, res: 0.75, fenv: 0.5, md: 0.2, ms: 0, drive: 0.4, ...mono, glide: 0.08, dist: 0.2, level: 0.42 },
    "Screamer": { awave: SAW, uni: 3, detune: 0.2, blevel: 0.5, bfb: 0.4, dist: 0.6, ftype: LP24, cutoff: 6000, ...mono, level: 0.41 },
    "Big Room Lead": { ...saws(7, 0.45, 1), sub: 0.25, ftype: LP24, cutoff: 5000, dist: 0.25, ar: 0.2, level: 0.43 },
    "Flute": { blevel: 0.15, batt: 0.1, noise: 0.04, aa: 0.06, ...vibrato(0.006, 5), ...mono, level: 0.44 },
  },
  "Supersaws & Chords": {
    "Anthem Chords": { ...saws(7, 0.4, 1), ftype: LP24, cutoff: 7000, aa: 0.01, ar: 0.4, level: 0.21 },
    "Progressive Chords": { ...saws(5, 0.3), ftype: LP24, cutoff: 1200, fenv: 0.4, md: 0.25, ms: 0.1, ad: 0.4, as: 0.2, ar: 0.3, level: 0.29 },
    "Hyper Saw": { ...saws(7, 0.55, 1), sub: 0.2, dist: 0.1, level: 0.4 },
    "Detuned Squares": { awave: SQUARE, blevel: 0, uni: 5, detune: 0.3, ftype: LP12, cutoff: 4000, level: 0.11 },
    "Future Bass Chords": { ...saws(7, 0.35), ftype: LP24, cutoff: 2500, ...sync(2, DIV["1/4"], 3), l2trig: false, m1src: 2, m1dst: 10, m1amt: 0.5, level: 0.22 },
    "Lush Saws": { ...saws(6, 0.3), ftype: LP24, cutoff: 5000, aa: 0.05, ar: 0.8, level: 0.23 },
    "Saw Square Chords": { awave: 2.5, blevel: 0, uni: 3, detune: 0.2, ftype: LP24, cutoff: 6000, level: 0.17 },
    "House Piano": { algo: 3, blevel: 0.45, bdec: 0.8, bsus: 0.2, bvel: 0.5, cratio: 2, clevel: 0.3, dratio: 7, dlevel: 0.1, ddec: 0.1, dsus: 0, ad: 2, as: 0.3, ar: 0.5, level: 0.23 },
  },
  Pads: {
    "Warm Pad": { ...saws(4, 0.25), ftype: LP24, cutoff: 1500, aa: 0.8, ar: 1.5, l1rate: 0.15, l1trig: false, m1src: 1, m1dst: 1, m1amt: 0.1, level: 0.31 },
    "Glass Pad": { bratio: 3, blevel: 0.25, aa: 1.2, ar: 2, l1rate: 0.2, l1trig: false, m1src: 1, m1dst: 5, m1amt: 0.15, level: 0.23 },
    "Choir": { awave: VOWEL, blevel: 0, uni: 5, detune: 0.2, aa: 1, ar: 1.5, ftype: LP12, cutoff: 3000, l2rate: 0.3, m1src: 2, m1dst: 8, m1amt: 0.08, level: 0.54 },
    "Dark Pad": { ...saws(5, 0.25), ftype: LP24, cutoff: 500, res: 0.3, aa: 1.5, ar: 2, sub: 0.3, level: 0.39 },
    "Evolving Pad": { awave: 2.5, blevel: 0, uni: 4, detune: 0.25, ftype: LP24, cutoff: 2000, aa: 2, ar: 3, l1rate: 0.07, l1trig: false, m1src: 1, m1dst: 8, m1amt: 0.3,
      l2rate: 0.11, m2src: 2, m2dst: 1, m2amt: 0.2, level: 0.35 },
    "Strings": { ...saws(6, 0.2), ftype: LP24, cutoff: 3000, fenv: 0.1, ma: 0.5, md: 1, ms: 0.5, aa: 0.4, ar: 1, ...vibrato(0.003, 5), level: 0.36 },
    "Shimmer Pad": { awave: TRI, algo: 3, bratio: 4, blevel: 0.15, cratio: 2, clevel: 0.3, dratio: 8, dlevel: 0.08, aa: 1, ar: 2.5, uni: 2, detune: 0.15, level: 0.24 },
    "Air Pad": { alevel: 0.8, blevel: 0, noise: 0.8, ftype: LP12, cutoff: 2500, res: 0.2, l1rate: 0.12, l1trig: false, m1src: 1, m1dst: 1, m1amt: 0.25, aa: 1.5, ar: 2, level: 0.24 },
    "Analog Pad": { awave: 2.5, blevel: 0, uni: 3, detune: 0.25, ftype: LP24, cutoff: 2500, aa: 0.5, ar: 1.2, level: 0.22 },
    "Sweep Pad": { ...saws(5, 0.3), ftype: LP24, cutoff: 700, res: 0.35, ...sync(1, 0, 1), l1trig: false, m1src: 1, m1dst: 1, m1amt: 0.45, aa: 1, ar: 2, level: 0.38 },
  },
  Basses: {
    "Reese": { ...saws(3, 0.25, 0.2), ftype: LP24, cutoff: 600, ...mono, sub: 0.2, dist: 0.15, level: 0.46 },
    "Sub Bass": { blevel: 0, mono: 1, aa: 0.003, ar: 0.08, dist: 0.05, vel: 0.2, level: 0.41 },
    "FM Bass": { blevel: 0.5, bdec: 0.2, bsus: 0.2, ...mono, glide: 0.03, ftype: LP24, cutoff: 2500, level: 0.42 },
    "Wobble Bass": { ...saws(2, 0.1, 0.3), ftype: LP24, cutoff: 300, res: 0.45, ...sync(1, DIV["1/8"]), m1src: 1, m1dst: 1, m1amt: 0.45, ...mono, dist: 0.3, sub: 0.3, level: 0.46 },
    "Acid Bass": { awave: SAW, blevel: 0, ftype: LP24, cutoff: 350, res: 0.8, fenv: 0.55, md: 0.18, ms: 0, ...mono, glide: 0.06, drive: 0.3, level: 0.32 },
    "Pluck Bass": { awave: SAW, blevel: 0, ftype: LP24, cutoff: 400, fenv: 0.5, md: 0.12, ms: 0, sub: 0.3, ad: 0.3, as: 0.2, ar: 0.1, mono: 1, level: 0.9 },
    "Donk": { bratio: 2, blevel: 0.6, bdec: 0.06, bsus: 0, m1src: 3, m1dst: 0, m1amt: 0.1, ma: 0, md: 0.03, ms: 0, ...pluckAmp(0.25, 0.1), level: 0.72 },
    "Deep House Bass": { awave: TRI, blevel: 0.3, bdec: 0.3, bsus: 0.1, ftype: LP24, cutoff: 1200, ad: 0.5, as: 0.3, ar: 0.1, mono: 1, level: 0.77 },
    "Square Bass": { awave: SQUARE, blevel: 0, ftype: LP24, cutoff: 800, fenv: 0.3, md: 0.2, ...mono, level: 0.35 },
    "Neuro Bass": { awave: VOWEL, blevel: 0.6, bfb: 0.3, sub: 0.3, ...sync(1, DIV["1/16"]), m1src: 1, m1dst: 3, m1amt: 0.3, dist: 0.5, ftype: LP24, cutoff: 3000, res: 0.3, ...mono, level: 0.5 },
    "Slap Bass": { bratio: 3, blevel: 0.5, bdec: 0.05, bsus: 0, ad: 0.6, as: 0.2, ar: 0.1, mono: 1, level: 0.53 },
    "Analog Bass": { awave: 2.5, blevel: 0, uni: 2, detune: 0.1, ftype: LP24, cutoff: 400, res: 0.25, fenv: 0.3, md: 0.25, drive: 0.3, ...mono, level: 0.39 },
  },
  "808s": {
    "808": eight08({ level: 0.44 }),
    "808 Long": eight08({ ad: 5, dist: 0.2, level: 0.44 }),
    "808 Distorted": eight08({ dist: 0.7, drive: 0.3, level: 0.41 }),
    "808 Slide": eight08({ mono: 2, glide: 0.12, ad: 3, level: 0.44 }),
    "808 Punch": eight08({ m1amt: 0.3, md: 0.04, ad: 1.5, level: 0.45 }),
    "808 Boom": eight08({ sub: 0.3, ad: 4, dist: 0.15, level: 0.45 }),
    "808 Knock": eight08({ blevel: 0.3, bdec: 0.05, bsus: 0, dist: 0.45, ad: 1.8, level: 0.43 }),
    "808 Tape": eight08({ ftype: LP24, cutoff: 900, dist: 0.35, level: 0.44 }),
  },
  "Growls & Wobbles": {
    "Yoi Growl": growl({ awave: VOWEL, blevel: 0.6, bfb: 0.35, fm: 0.4, ...sync(1, DIV["1/4"], 1), m1src: 1, m1dst: 5, m1amt: 0.4, m2src: 1, m2dst: 1, m2amt: 0.3,
      cutoff: 1400, res: 0.45, sub: 0.3, dist: 0.6, level: 0.46 }),
    "Wobble 1/8": growl({ awave: SAW, blevel: 0.3, cutoff: 400, res: 0.5, ...sync(1, DIV["1/8"]), m1src: 1, m1dst: 1, m1amt: 0.55, dist: 0.5, sub: 0.35, level: 0.42 }),
    "Wobble 1/4T": growl({ awave: SAW, blevel: 0.3, cutoff: 400, res: 0.5, ...sync(1, DIV["1/4T"]), m1src: 1, m1dst: 1, m1amt: 0.55, dist: 0.5, sub: 0.35, level: 0.42 }),
    "Metal Growl": growl({ awave: SAW, algo: 1, bratio: 1.5, blevel: 0.55, cratio: 3, clevel: 0.3, fm: 0.6, ...sync(1, DIV["1/8"]), m1src: 1, m1dst: 3, m1amt: 0.35,
      dist: 0.65, cutoff: 4000, res: 0.35, level: 0.44 }),
    "Talking Bass": growl({ awave: VOWEL, blevel: 0, ...sync(1, DIV["1/4"], 1), m1src: 1, m1dst: 8, m1amt: 0.25, m2src: 1, m2dst: 1, m2amt: 0.3, cutoff: 1100, res: 0.5, sub: 0.25,
      dist: 0.45, level: 0.47 }),
    "Riddim": growl({ awave: SQUARE, bratio: 2, blevel: 0.5, bfb: 0.2, ...sync(1, DIV["1/16"], 4), m1src: 1, m1dst: 3, m1amt: 0.35, dist: 0.7, cutoff: 2500, level: 0.4 }),
    "Tearout": growl({ awave: VOWEL, afb: 0.5, blevel: 0.7, fm: 0.7, ...sync(1, DIV["1/16T"], 2), m1src: 1, m1dst: 1, m1amt: 0.4, dist: 0.8, cutoff: 3000, res: 0.3, level: 0.47 }),
    "Screech": growl({ awave: SAW, bratio: 3, blevel: 0.6, bfb: 0.5, ftype: HP12, cutoff: 300, ...sync(1, DIV["1/8"]), m1src: 1, m1dst: 3, m1amt: 0.4, dist: 0.6, level: 0.58 }),
    "Grime Wobble": growl({ awave: SQUARE, blevel: 0, cutoff: 500, res: 0.6, ...sync(1, DIV["1/4"]), m1src: 1, m1dst: 1, m1amt: 0.5, dist: 0.4, sub: 0.3, level: 0.4 }),
    "Macro Growl": growl({ awave: VOWEL, blevel: 0.3, sub: 0.3, m1src: 5, m1dst: 3, m1amt: 0.7, m2src: 5, m2dst: 1, m2amt: 0.5, cutoff: 700, res: 0.4, dist: 0.55, macro: 0.5, level: 0.47 }),
    "Robot": growl({ awave: SQUARE, bratio: 0.5, blevel: 0.5, ...sync(1, DIV["1/8"], 5), m1src: 1, m1dst: 1, m1amt: 0.4, m2src: 1, m2dst: 5, m2amt: 0.3, cutoff: 1800, res: 0.4, sub: 0.3,
      dist: 0.5, level: 0.4 }),
    "Brostep": growl({ awave: SAW, uni: 2, detune: 0.1, algo: 1, blevel: 0.6, bfb: 0.4, cratio: 2, clevel: 0.3, fm: 0.6, ...sync(1, DIV["1/8T"], 1), m1src: 1, m1dst: 3, m1amt: 0.4,
      m2src: 1, m2dst: 1, m2amt: 0.35, cutoff: 1500, res: 0.45, dist: 0.7, sub: 0.3, level: 0.41 }),
  },
  Stabs: {
    "Dubstep Stab": { awave: SAW, uni: 3, detune: 0.2, blevel: 0.6, bdec: 0.15, bsus: 0, ...pluckAmp(0.25, 0.15), dist: 0.6, level: 0.44 },
    "House Organ Stab": organ({ alevel: 0.6, bratio: 2, blevel: 0.4, cratio: 3, clevel: 0.3, dratio: 4, dlevel: 0.15 }, { ...pluckAmp(0.3, 0.1), ftype: LP24, cutoff: 4000, level: 0.38 }),
    "Rave Stab": { ...saws(5, 0.45), blevel: 0.3, ...pluckAmp(0.4, 0.2), dist: 0.3, level: 0.51 },
    "Chord Stab": { awave: SQUARE, blevel: 0, uni: 3, detune: 0.2, ftype: LP24, cutoff: 1500, fenv: 0.4, md: 0.12, ...pluckAmp(0.25, 0.2), level: 0.25 },
    "Brass Stab": { awave: SAW, blevel: 0.4, batt: 0.03, ftype: LP24, cutoff: 1200, fenv: 0.35, ma: 0.03, md: 0.2, ...pluckAmp(0.35, 0.2), level: 0.53 },
    "Hoover Stab": { ...saws(7, 0.6, 1), m1src: 3, m1dst: 0, m1amt: -0.05, md: 0.2, ms: 0, ...pluckAmp(0.4, 0.25), level: 0.32 },
    "Metallic Stab": { algo: 3, bratio: 1.41, blevel: 0.5, clevel: 0.5, dratio: 3.14, dlevel: 0.3, ...pluckAmp(0.5, 0.3), level: 0.3 },
    "Orchestra Hit": { ...saws(5, 0.2), noise: 0.1, ftype: LP24, cutoff: 2500, fenv: 0.3, md: 0.15, ...pluckAmp(0.6, 0.3), level: 0.26 },
  },
  Organs: {
    "Gospel 888000000": organ({ sub: 0.8, alevel: 0.8, bratio: 1.5, blevel: 0.8 }, { ...leslie(6.7), drive: 0.25, level: 0.2 }),
    "Jazz 888000000 Perc": organ({ sub: 0.8, alevel: 0.8, bratio: 1.5, blevel: 0.8, cratio: 3, clevel: 0.6, cdec: 0.25, csus: 0 }, { ...leslie(0.8), level: 0.11 }),
    "Rock 888880000": organ({ sub: 0.8, alevel: 0.8, bratio: 1.5, blevel: 0.8, cratio: 2, clevel: 0.8, dratio: 4, dlevel: 0.6 }, { ...leslie(6.7), drive: 0.5, level: 0.24 }),
    "Ballad 008800000": organ({ alevel: 0.7, bratio: 2, blevel: 0.5 }, { ...leslie(0.8), level: 0.19 }),
    "Full Organ": organ({ sub: 0.7, alevel: 0.7, bratio: 2, blevel: 0.7, cratio: 3, clevel: 0.7, dratio: 4, dlevel: 0.7 }, { ...leslie(6.7), drive: 0.35, level: 0.21 }),
    "Church Organ": organ({ sub: 0.5, alevel: 0.7, bratio: 2, blevel: 0.5, cratio: 4, clevel: 0.35, dratio: 8, dlevel: 0.2 }, { aa: 0.08, ar: 0.5, level: 0.16 }),
    "90s House Organ": organ({ alevel: 0.7, bratio: 2, blevel: 0.5, cratio: 3, clevel: 0.4, dratio: 4, dlevel: 0.3 }, { ad: 0.25, as: 0, ar: 0.08, ftype: LP24, cutoff: 3000, level: 0.32 }),
    "Reggae Bubble": organ({ alevel: 0.6, bratio: 2, blevel: 0.4, cratio: 3, clevel: 0.3 }, { ad: 0.12, as: 0, ar: 0.05, drive: 0.1, level: 0.6 }),
  },
  "Keys & Bells": {
    "FM E-Piano": { algo: 3, blevel: 0.45, bdec: 1.5, bsus: 0.15, bvel: 0.6, clevel: 0.5, dratio: 14, dlevel: 0.2, ddec: 0.12, dsus: 0, dvel: 0.7, ad: 2.5, as: 0.2, ar: 0.4, vel: 0.4, level: 0.32 },
    "Tine Piano": { algo: 3, blevel: 0.4, bdec: 1.2, bsus: 0.1, bvel: 0.6, clevel: 0.5, dratio: 14, dlevel: 0.3, ddec: 0.15, dsus: 0, dvel: 0.8, ad: 2.5, as: 0.2, ar: 0.4, vel: 0.4, level: 0.33 },
    "Tubular Bell": { algo: 3, bratio: 3.5, blevel: 0.45, bdec: 2, bsus: 0.1, clevel: 0.5, dratio: 1.4, dlevel: 0.3, ddec: 1.5, dsus: 0, ...pluckAmp(4, 2), level: 0.37 },
    "Music Box": { oct: 1, bratio: 5, blevel: 0.25, bdec: 0.3, bsus: 0, ...pluckAmp(1.5, 0.8), level: 0.47 },
    "Vibraphone": { bratio: 4, blevel: 0.25, bdec: 0.3, bsus: 0, l1rate: 5, l1trig: false, m1src: 1, m1dst: 10, m1amt: 0.3, ...pluckAmp(2.5, 0.6), level: 0.37 },
    "Clav": { awave: 3.6, uni: 2, detune: 0.08, blevel: 0.4, bdec: 0.1, bsus: 0.2, ftype: HP12, cutoff: 150, ad: 0.5, as: 0.1, ar: 0.05, vel: 0.7, level: 0.83 },
    "Celesta": { oct: 1, bratio: 4, blevel: 0.2, bdec: 0.15, bsus: 0, ...pluckAmp(1, 0.5), level: 0.5 },
    "Glockenspiel": { oct: 1, bratio: 3.5, blevel: 0.3, bdec: 0.25, bsus: 0, ...pluckAmp(1.2, 0.8), level: 0.49 },
  },
};
