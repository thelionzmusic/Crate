// Crate Drum's factory sounds, by type. Each type has a starting point (TYPE_START) that the panel's
// Type switch loads, as Live's Drum Synth models do; presets build on it. Kicks and toms follow
// the keyboard from C1. Levels are balanced like the other synths' (tests/web/instruments.js).

const SINE = 0, TRI = 1, SAW = 2;
const NOISE = 0, BLIP = 1, BEATER = 2;
const LOW = 0, BAND = 1, HIGH = 2;

// each type's starting point
export const TYPE_START = [
  { model: 0, tune: 50, key: true, bpitch: 36, bptime: 35, bdecay: 450, click: 0.35 },                                         // kick
  { model: 1, tune: 190, key: false, bpitch: 7, bptime: 20, bdecay: 140, click: 0.3, noise: 0.7, nfilter: HIGH, ncut: 2500, ndecay: 180, choke: false },  // snare
  { model: 2, blevel: 0, click: 0, noise: 1, nfilter: BAND, ncut: 1200, nres: 0.3, ndecay: 180, nclap: 3, nspace: 10, choke: false },   // clap
  { model: 3, blevel: 0, click: 0, metal: 1, mfreq: 400, mdecay: 50, mtone: 7000, noise: 0.2, nfilter: HIGH, ncut: 8000, ndecay: 40, key: false },  // hat
  { model: 4, tune: 100, key: true, bpitch: 12, bptime: 60, bdecay: 420, click: 0.25, choke: false },                         // tom
  { model: 5, tune: 450, key: false, bwave: TRI, bpitch: 5, bptime: 8, bhold: 0, bdecay: 45, click: 0.6, ctype: BLIP, ctone: 1800, cdecay: 5, choke: false },  // rim
  { model: 6, tune: 220, key: false, bpitch: 5, bptime: 30, bdecay: 280, click: 0.3, choke: false },                          // perc
  { model: 7, blevel: 0, click: 0, metal: 1, mfreq: 350, mdecay: 1600, mtone: 6000, noise: 0.35, nfilter: HIGH, ncut: 6000, ndecay: 1200, key: false, choke: false },  // cymbal
  { model: 8, tune: 100, key: false, bpitch: 72, bptime: 100, bpcurve: 0.3, bdecay: 300, click: 0, choke: false },           // fx
];
const of = (type) => (extra = {}) => ({ ...TYPE_START[type], ...extra });
const kick = of(0), snare = of(1), clap = of(2), hat = of(3), tom = of(4), rim = of(5), perc = of(6), cymbal = of(7), fx = of(8);

export const DRUM_PRESETS = {
  Kicks: {
    "808 Kick": kick({ bpitch: 24, bptime: 30, bpcurve: 0.7, bhold: 50, bdecay: 1800, bcurve: 0.3, click: 0.1, ctype: BLIP, drive: 0.1, level: 0.39 }),
    "909 Kick": kick({ bwave: 0.3, bpitch: 30, bptime: 25, bdecay: 450, click: 0.5, ctone: 6000, cdecay: 4, drive: 0.2, level: 0.44 }),
    "Techno Rumble": kick({ bdecay: 900, drive: 0.5, clip: 0.3, low: 3, level: 0.24 }),
    "Hard Techno": kick({ bpitch: 48, bptime: 20, bdrive: 0.6, drive: 0.6, clip: 0.6, bdecay: 600, level: 0.41 }),
    "Trap 808": kick({ tune: 45, bpitch: 20, bhold: 80, bdecay: 2500, bcurve: 0.3, click: 0.1, drive: 0.15, level: 0.4 }),
    "House Thump": kick({ bdecay: 350, bpitch: 36, bptime: 35, click: 0.4, level: 0.44 }),
    "Punchy": kick({ bpitch: 40, bptime: 15, bdecay: 300, click: 0.6, ctype: BEATER, cdecay: 8, level: 0.45 }),
    "Deep Sub": kick({ tune: 40, bpitch: 18, bdecay: 1200, click: 0.15, level: 0.35 }),
    "Hardstyle": kick({ tune: 55, bwave: 0.8, bpitch: 48, bptime: 60, bdrive: 0.9, drive: 0.8, clip: 0.7, bdecay: 700, level: 0.47 }),
    "Psytrance": kick({ tune: 55, bpitch: 48, bptime: 15, bdecay: 200, click: 0.5, level: 0.5 }),
    "DnB Kick": kick({ tune: 55, bdecay: 250, click: 0.6, ctype: BEATER, ctone: 4000, level: 0.47 }),
    "Lo-fi Kick": kick({ bdecay: 300, high: -6, low: 2, drive: 0.3, level: 0.38 }),
    "Boom": kick({ tune: 42, bhold: 100, bdecay: 1500, low: 4, click: 0.2, level: 0.22 }),
    "Tight Kick": kick({ bpitch: 30, bptime: 12, bdecay: 180, level: 0.51 }),
    "Acoustic Kick": kick({ bwave: 0.2, bpitch: 12, bptime: 20, bdecay: 300, click: 0.7, ctype: BEATER, ctone: 3000, noise: 0.1, nfilter: LOW, ncut: 800, ndecay: 60, level: 0.47 }),
    "Clicky Kick": kick({ click: 0.9, ctype: BLIP, ctone: 3000, cdecay: 3, level: 0.41 }),
    "Distorted Kick": kick({ drive: 0.7, clip: 0.4, level: 0.33 }),
    "Garage Kick": kick({ bpitch: 30, bdecay: 400, click: 0.4, high: 2, level: 0.42 }),
    "Minimal Kick": kick({ tune: 60, bpitch: 24, bptime: 10, bdecay: 220, click: 0.2, level: 0.49 }),
    "Electro Kick": kick({ bwave: 0.5, bptime: 18, bdecay: 350, drive: 0.3, level: 0.44 }),
    "Afro House Kick": kick({ tune: 52, bpitch: 24, bptime: 30, bdecay: 500, click: 0.3, level: 0.4 }),
    "Big Room Kick": kick({ bpitch: 48, bptime: 35, bdecay: 450, bdrive: 0.4, drive: 0.4, clip: 0.5, click: 0.5, level: 0.36 }),
    "Dubstep Kick": kick({ bdecay: 350, click: 0.6, drive: 0.3, clip: 0.3, level: 0.31 }),
    "Soft Kick": kick({ click: 0, bdecay: 400, bpcurve: 0.8, level: 0.42 }),
    "Rumble Tail": kick({ bhold: 30, bdecay: 1400, bcurve: 0.2, drive: 0.4, clip: 0.4, level: 0.33 }),
  },
  Snares: {
    "808 Snare": snare({ tune: 180, ncut: 3000, ndecay: 160, level: 0.28 }),
    "909 Snare": snare({ tune: 200, bwave: 0.3, ncut: 4000, ndecay: 220, level: 0.27 }),
    "Trap Snare": snare({ tune: 220, noise: 0.9, ndecay: 250, click: 0.5, drive: 0.2, level: 0.42 }),
    "Rimmy Snare": snare({ ctype: BLIP, ctone: 1800, cdecay: 10, click: 0.5, level: 0.24 }),
    "Fat Snare": snare({ tune: 160, bdecay: 200, noise: 0.8, ndecay: 300, low: 3, level: 0.22 }),
    "Tight Snare": snare({ bdecay: 90, ndecay: 110, level: 0.28 }),
    "Lo-fi Snare": snare({ high: -5, drive: 0.3, level: 0.57 }),
    "Clap Snare": snare({ nclap: 3, nspace: 9, level: 0.24 }),
    "Brush Snare": snare({ blevel: 0.2, noise: 0.8, nfilter: BAND, ncut: 5000, nattack: 15, ndecay: 300, click: 0, level: 0.49 }),
    "Big Room Snare": snare({ ndecay: 350, drive: 0.4, clip: 0.3, level: 0.3 }),
    "DnB Snare": snare({ tune: 240, bdecay: 120, noise: 0.9, ncut: 3500, ndecay: 180, click: 0.6, level: 0.21 }),
    "Acoustic Snare": snare({ tune: 210, bwave: 0.4, nfilter: BAND, ncut: 4500, nres: 0.3, ndecay: 250, click: 0.6, ctype: BEATER, level: 0.38 }),
    "Piccolo": snare({ tune: 300, bdecay: 100, ndecay: 140, level: 0.25 }),
    "Deep Snare": snare({ tune: 150, bdecay: 260, nfilter: LOW, ncut: 3500, ndecay: 300, level: 0.37 }),
    "Gated Snare": snare({ bdecay: 250, bcurve: 0, ndecay: 400, level: 0.2 }),
    "Snap Snare": snare({ noise: 0.9, ncut: 5000, ndecay: 90, level: 0.22 }),
    "Distorted Snare": snare({ drive: 0.7, clip: 0.5, level: 0.37 }),
    "Soft Snare": snare({ click: 0, noise: 0.5, nfilter: LOW, ncut: 6000, level: 0.45 }),
    "Reggaeton Snare": snare({ tune: 230, bdecay: 110, noise: 0.8, ndecay: 150, level: 0.24 }),
    "Electro Snare": snare({ tune: 200, bwave: 0.6, bpitch: 12, noise: 0.6, ncut: 2000, level: 0.3 }),
  },
  Claps: {
    "808 Clap": clap({ level: 0.68 }),
    "909 Clap": clap({ ncut: 1500, ndecay: 220, nclap: 4, nspace: 8, level: 0.59 }),
    "Wide Clap": clap({ nspace: 14, ndecay: 250, level: 0.8 }),
    "Tight Clap": clap({ ndecay: 90, nspace: 7, level: 0.87 }),
    "Big Clap": clap({ ndecay: 400, nres: 0.2, level: 0.68 }),
    "Lo-fi Clap": clap({ high: -6, drive: 0.3, level: 0.62 }),
    "Bright Clap": clap({ ncut: 2500, level: 0.6 }),
    "Snap": clap({ nclap: 1, nfilter: HIGH, ncut: 3000, ndecay: 60, click: 0.5, level: 0.21 }),
    "Group Clap": clap({ nclap: 4, nspace: 20, ndecay: 300, level: 0.81 }),
    "Distorted Clap": clap({ drive: 0.6, clip: 0.4, level: 0.37 }),
  },
  Hats: {
    "808 Closed Hat": hat({ level: 0.4 }),
    "808 Open Hat": hat({ mdecay: 420, ndecay: 300, level: 0.4 }),
    "909 Closed Hat": hat({ noise: 0.5, ncut: 8000, mdecay: 45, level: 0.36 }),
    "909 Open Hat": hat({ noise: 0.5, ncut: 8000, mdecay: 500, ndecay: 400, level: 0.36 }),
    "Tight Hat": hat({ mdecay: 20, ndecay: 15, level: 0.4 }),
    "Trap Hat": hat({ mdecay: 35, high: 2, level: 0.35 }),
    "Shaker": hat({ metal: 0, noise: 1, ncut: 6000, nattack: 8, ndecay: 70, level: 0.26 }),
    "Pedal Hat": hat({ mdecay: 90, mtone: 5000, level: 0.34 }),
    "Lo-fi Hat": hat({ mtone: 5000, mfreq: 330, drive: 0.5, clip: 0.2, mdecay: 70, level: 0.63 }),
    "Bright Hat": hat({ mtone: 10000, level: 0.54 }),
    "Dark Hat": hat({ mtone: 4000, mfreq: 300, level: 0.32 }),
    "Sizzle Open Hat": hat({ mdecay: 800, noise: 0.4, ndecay: 700, level: 0.37 }),
  },
  Toms: {
    "Low Tom": tom({ tune: 80, level: 0.42 }),
    "Mid Tom": tom({ tune: 110, level: 0.42 }),
    "High Tom": tom({ tune: 150, level: 0.42 }),
    "808 Tom": tom({ bpitch: 7, bptime: 100, bdecay: 600, click: 0.1, level: 0.39 }),
    "Floor Tom": tom({ tune: 65, bdecay: 700, low: 2, level: 0.35 }),
    "Electro Tom": tom({ bpitch: 24, bptime: 80, bwave: 0.4, level: 0.45 }),
    "Syndrum": tom({ bwave: TRI, bpitch: 30, bptime: 200, bpcurve: 0.3, bdecay: 600, level: 0.48 }),
    "Acoustic Tom": tom({ noise: 0.1, nfilter: LOW, ncut: 1500, ndecay: 120, click: 0.4, ctype: BEATER, level: 0.41 }),
  },
  Rims: {
    "808 Rim": rim({ level: 0.83 }),
    "909 Rim": rim({ tune: 500, bdecay: 35, click: 0.8, ctone: 2500, level: 0.82 }),
    "Sidestick": rim({ tune: 400, bdecay: 30, noise: 0.5, nfilter: BAND, ncut: 3000, ndecay: 40, level: 0.59 }),
    "Woodblock": rim({ tune: 700, bwave: SINE, bdecay: 60, click: 0.4, level: 0.79 }),
    "Clave": rim({ tune: 800, bwave: SINE, bdecay: 50, click: 0.3, level: 0.85 }),
  },
  Percussion: {
    "808 Cowbell": perc({ blevel: 0, click: 0, metal: 0.8, mfreq: 540, mdecay: 250, mtone: 1500, level: 0.33 }),
    "Conga": perc({ tune: 200, bdecay: 300, level: 0.45 }),
    "Bongo": perc({ tune: 350, bdecay: 180, click: 0.4, level: 0.51 }),
    "Tambourine": perc({ blevel: 0, click: 0, metal: 0.6, mfreq: 600, mdecay: 200, mtone: 8000, noise: 0.4, nfilter: HIGH, ncut: 7000, nattack: 5, ndecay: 150, level: 0.62 }),
    "Shaker Long": perc({ blevel: 0, click: 0, noise: 1, nfilter: HIGH, ncut: 5000, nattack: 20, ndecay: 140, level: 0.22 }),
    "Triangle": perc({ blevel: 0, click: 0, metal: 0.5, mfreq: 900, mdecay: 1500, mtone: 6000, level: 0.8 }),
    "Blip": perc({ tune: 600, bpitch: 24, bptime: 5, bdecay: 80, click: 0, level: 0.6 }),
    "Laser Tom": perc({ tune: 120, bpitch: 48, bptime: 150, bdecay: 400, level: 0.42 }),
  },
  Cymbals: {
    "808 Cymbal": cymbal({ level: 0.33 }),
    "Crash": cymbal({ mdecay: 2500, noise: 0.5, ncut: 5000, ndecay: 2000, level: 0.23 }),
    "Ride": cymbal({ mfreq: 500, mdecay: 2000, click: 0.3, ctype: BLIP, ctone: 8000, level: 0.31 }),
    "China": cymbal({ mfreq: 280, drive: 0.4, level: 0.42 }),
    "Splash": cymbal({ mdecay: 800, ndecay: 600, level: 0.33 }),
    "Trashy Crash": cymbal({ mdecay: 2000, drive: 0.5, clip: 0.3, level: 0.3 }),
  },
  FX: {
    "Zap": fx({ level: 0.45 }),
    "Laser": fx({ tune: 300, bwave: TRI, bpitch: 60, bptime: 300, bpcurve: 0, bdecay: 400, level: 0.52 }),
    "Noise Burst": fx({ blevel: 0, noise: 1, nfilter: LOW, ncut: 8000, ndecay: 800, level: 0.22 }),
    "Impact": fx({ tune: 35, bpitch: 24, bdecay: 3000, noise: 0.5, nfilter: LOW, ncut: 1000, ndecay: 1500, drive: 0.4, level: 0.39 }),
    "Glitch": fx({ blevel: 0, noise: 1, nfilter: HIGH, ncut: 5000, nclap: 4, nspace: 3, ndecay: 40, click: 1, ctype: BLIP, level: 0.25 }),
    "Bloop": fx({ tune: 200, key: true, bpitch: 12, bptime: 60, bpcurve: 0, bdecay: 150, level: 0.53 }),
  },
};
