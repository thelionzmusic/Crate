// Crate's instruments, rendered through their wasm builds (the browser engine's; the native
// engine runs the same C++, which crate-engine --selftest checks). For each: the page's
// parameters match the module's, and every preset uses real parameters within range, is
// heard, isn't clipped, sits within 1.5 dB of the others in loudness, and ends after its release.
// Then the modules are rebuilt and compared, if clang is here, so a stale .wasm can't ship.
//   node tests/web/instruments.js
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const DIR = path.join(__dirname, '../../crate/web/js/produce/instruments');
// what each kind of preset is played with: low notes for basses, chords for what's played in chords
const CHORD = [60, 64, 67];
const SR = 48000, TARGET = -14, NOTES = { '808s': [36], Basses: [41], 'Growls & Wobbles': [41], 'Supersaws & Chords': CHORD, Pads: CHORD, Stabs: CHORD, Organs: CHORD,
  'Jazz & Gospel': CHORD, 'Rock & Soul': CHORD, 'Church & Theatre': CHORD, Textures: CHORD };
const fails = [];
const check = (name, ok, info = '') => { if (!ok) { fails.push(name); console.log(`FAIL ${name} ${info}`); } };

function instance(file) {
  const x = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(path.join(DIR, file))), {}).exports;
  x.__wasm_call_ctors(); x.init(SR);
  const bytes = new Uint8Array(x.memory.buffer, x.keys(), 8192), keys = [];
  for (let i = 0, k = ''; keys.length < x.count(); i++) { if (bytes[i]) k += String.fromCharCode(bytes[i]); else { keys.push(k); k = ''; } }
  return { x, keys };
}

// a preset's notes held 1.5 s at velocity 100, then released; up to 14 s in all
function render(file, params, notes) {
  const { x, keys } = instance(file);
  for (const [k, v] of Object.entries(params)) x.set(keys.indexOf(k), +v);
  x.tempo(128);
  notes.forEach((p, i) => x.noteOn(i + 1, p, 100 / 127));
  const left = new Float32Array(x.memory.buffer, x.left(), 128), right = new Float32Array(x.memory.buffer, x.right(), 128);
  const W = SR / 10, out = { loud: 0, peak: 0, finite: true, ended: false };
  let t = 0, quiet = 0, e = 0, n = 0;
  while (t < 14 * SR) {
    if (t === Math.floor(1.5 * SR / 128) * 128) notes.forEach((_, i) => x.noteOff(i + 1));
    x.render(128); t += 128;
    let pk = 0;
    for (let i = 0; i < 128; i++) {
      const l = left[i], r = right[i];
      if (!Number.isFinite(l) || !Number.isFinite(r)) out.finite = false;
      pk = Math.max(pk, Math.abs(l), Math.abs(r)); e += l * l + r * r; n++;
    }
    out.peak = Math.max(out.peak, pk);
    if (n >= W) { out.loud = Math.max(out.loud, Math.sqrt(e / (2 * n))); e = n = 0; }
    if (t > 1.5 * SR) { quiet = pk < 3e-4 ? quiet + 128 : 0; if (quiet > SR * 0.2) { out.ended = true; break; } }
  }
  out.db = 20 * Math.log10(out.loud || 1e-9);
  return out;
}

(async () => {
  const { INSTRUMENTS } = await import(path.join(DIR, 'index.js'));
  const presets = { fm: (await import(path.join(DIR, 'fm-presets.js'))).FM_PRESETS, add: (await import(path.join(DIR, 'add-presets.js'))).ADD_PRESETS };
  for (const [type, def] of Object.entries(INSTRUMENTS)) {
    const { keys } = instance(def.wasm), mine = def.params.map((p) => p.k);
    check(`${type}: page and module list the same parameters`, keys.join() === mine.join(), `${keys.filter((k) => !mine.includes(k))} / ${mine.filter((k) => !keys.includes(k))}`);
    let count = 0;
    for (const [cat, list] of Object.entries(presets[type] || {})) {
      for (const [name, params] of Object.entries(list)) {
        count++;
        for (const [k, v] of Object.entries(params)) {
          const p = def.byKey?.[k] ?? def.params.find((q) => q.k === k);
          check(`${type} ${name}: ${k} is a parameter, in range`, p && (p.bool ? typeof v === 'boolean' : p.opts ? Number.isInteger(v) && v >= 0 && v < p.opts.length : v >= p.min && v <= p.max), String(v));
        }
        const r = render(def.wasm, params, NOTES[cat] || [60]);
        check(`${type} ${name}: heard, unclipped, at its level, and ends`, r.finite && r.peak < 1 && Math.abs(r.db - TARGET) <= 1.5 && r.ended,
          `${r.db.toFixed(1)} dB, peak ${r.peak.toFixed(2)}, ${r.ended ? 'ends' : 'never ends'}`);
      }
    }
    console.log(`${type}: ${count} presets rendered`);
  }
  // the committed modules are what the C++ builds today
  let clang = true;
  try { execFileSync('clang++', ['--version'], { stdio: 'ignore' }); } catch { clang = false; }
  if (clang) {
    const before = Object.values(INSTRUMENTS).map((d) => fs.readFileSync(path.join(DIR, d.wasm)));
    execFileSync(path.join(__dirname, '../../native/synth/make-wasm.sh'), { stdio: 'ignore' });
    Object.values(INSTRUMENTS).forEach((d, i) => check(`${d.wasm} is up to date with native/synth`, before[i].equals(fs.readFileSync(path.join(DIR, d.wasm)))));
  } else console.log('clang not found: not checking the .wasm builds are current');
  console.log(fails.length ? `${fails.length} failed` : 'all passed');
  process.exit(fails.length ? 1 : 0);
})();
