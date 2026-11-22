// Production on the native engine: with Perform set to Crate's engine, Produce plays through it
// rather than the browser. Checks the same things as devices.js, measured by the engine's own
// meters: clips play, sends reach returns, the compressor works, the limiter holds, bypass,
// rewiring and reload hold; and the engine's parameter table matches the page's devices.
// Run against a Crate started with a studio-capable engine (CRATE_ENGINE=native/build-test/crate-engine)
// and the sample folder from produce.js added:
//   BASE=http://127.0.0.1:47800 ENGINE=native/build-test/crate-engine node tests/web/native_produce.js [screenshot dir]
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  await p.addInitScript(() => localStorage.setItem('perf', JSON.stringify({ engine: 'native', api: 'null', buffer: 256 })));
  const errs = []; p.on('pageerror', (e) => errs.push('PAGE ' + String(e))); p.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
  const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
  const S = (fn, arg) => p.evaluate(async ([src, a]) => {
    const e = await import('/js/produce/engine.js'), s = await import('/js/produce/set.js');
    return new Function('studio', 'P', 'set', 'a', `return (async () => { ${src} })()`)(e.studio, s.P, s, a);
  }, [fn, arg]);
  const wait = (ms) => p.waitForTimeout(ms);
  const peak = (expr, ms = 1500) => S(`let m = 0; const end = performance.now() + ${ms}; while (performance.now() < end) { m = Math.max(m, ${expr}); await new Promise((r) => setTimeout(r, 30)); } return m;`);
  const track = 'P.set.tracks[2]';

  await p.goto(BASE); await p.waitForSelector('#rows .r');
  await p.evaluate(() => fetch('/api/project/new', { method: 'POST', body: '{}' }));
  await p.click('#mProd'); await p.waitForSelector('.pc-track'); await wait(1200);
  check('Produce runs on the native engine', await S('return studio.native'));

  // the engine's devices and the page's agree on every parameter and default
  if (process.env.ENGINE) {
    const table = JSON.parse(execFileSync(process.env.ENGINE, ['--devices']).toString());
    const diff = await p.evaluate(async (t) => {
      const { DEVICES } = await import('/js/produce/fx/devices.js'), out = [];
      for (const [type, def] of Object.entries(DEVICES)) {
        const keys = def.params.map((x) => x.k);
        if (!t[type]) { out.push(`${type} missing`); continue; }
        for (const q of def.params) if (!(q.k in t[type]) || Math.abs(+q.def - t[type][q.k]) > 1e-9) out.push(`${type}.${q.k}`);
        for (const k of Object.keys(t[type])) if (!keys.includes(k)) out.push(`${type}.${k} extra`);
      }
      return out;
    }, table);
    check('engine and page devices agree', !diff.length, diff.join(', '));
  }

  await S(`const c = await set.makeClip({ kind: 'sample', f: 0, p: 'Loops/Drum Loop 124 bpm.wav' }); set.edit(() => { ${track}.clips[0] = c; ${track}.sends.A = 0.85; P.sel = ${track}.id; }); studio.launch(${track}, c);`);
  await wait(3000);
  check('track plays through the engine', (await peak(`studio.track(${track}).meter()`, 800)) > 0.05);
  check('send reaches the return', (await peak(`studio.ret(P.set.returns[0]).meter()`, 800)) > 0.01);

  await S(`set.edit(() => { const d = set.addDevice(${track}, 'comp'); d.params = { threshold: -40, ratio: 10, attack: 1, release: 50 }; });`);
  await wait(500);
  const gr = await S(`let m = 0; for (let i = 0; i < 40; i++) { m = Math.min(m, studio.device(${track}, P.dev).meter); await new Promise((r) => setTimeout(r, 30)); } return m;`);
  check('compressor reduces gain', gr < -6, `${gr.toFixed(1)} dB`);

  await S(`set.edit(() => { const d = set.addDevice(P.set.main, 'limiter'); d.params = { gain: 18, ceiling: -6 }; P.sel = 'main'; });`);
  await wait(600);
  const lim = await peak('studio.mainMeter()', 2000);
  check('limiter holds its ceiling', lim <= 10 ** (-6 / 20) * 1.01 && lim > 0.3, lim.toFixed(3));

  await S(`set.edit(() => { const d = set.addDevice(${track}, 'eq'); d.params = { f4: 1000, g4: 12, q4: 1 }; P.sel = ${track}.id; });`);
  await wait(300);
  const eq = await S(`const x = studio.device(${track}, P.dev), f = new Float32Array([1000, 100]), m = new Float32Array(2), ph = new Float32Array(2), out = [1, 1];
    for (const bq of x.bands.flat()) { bq.getFrequencyResponse(f, m, ph); out[0] *= m[0]; out[1] *= m[1]; } return out.map((v) => 20 * Math.log10(v));`);
  check('EQ display curve', Math.abs(eq[0] - 12) < 0.5 && Math.abs(eq[1]) < 1.5, eq.map((v) => v.toFixed(2)).join(' / '));
  await p.screenshot({ path: `${OUT}/native-devices.png` });

  // switching the compressor off, then the track's level and pan still apply; nothing errors
  await S(`set.edit(() => { ${track}.devices[0].on = false; });`); await wait(300);
  check('bypass keeps it playing', (await peak(`studio.track(${track}).meter()`, 600)) > 0.05);

  // a return deleted takes its strip and sends with it; the engine keeps running
  await S(`set.edit(() => set.removeReturn(P.set.returns[1]));`); await wait(300);
  check('return removed', await S(`return !studio.returns.has('B') && P.set.returns.length === 1`));

  // stopping: the track goes quiet
  await S(`studio.stopAll(true);`); await wait(800);
  check('stop is silent', (await peak(`studio.track(${track}).meter()`, 400)) < 0.001);

  // a browser preview plays straight out through Main
  await S(`await studio.preview({ kind: 'sample', f: 0, p: 'Drums/Kick 01.wav' });`);
  check('preview plays', (await peak('studio.mainMeter()', 500)) > 0.02);

  // the timeline plays its clips through the engine too
  await S(`set.edit(() => { P.set.arrangement = [{ id: 99, track: ${track}.id, start: 0, length: 8, clip: ${track}.clips[0] }]; }); studio.arrangement = P.set.arrangement; studio.playSong(0);`);
  await wait(2500);
  check('timeline plays', (await peak(`studio.track(${track}).meter()`, 800)) > 0.05);
  await S('studio.stopSong();');

  // saved and rebuilt on the engine after a reload
  await p.reload(); await p.waitForSelector('.pc-track'); await wait(1500);
  check('chain rebuilt after reload', await S(`return studio.native && ${track}.devices.map((d) => d.type).join() === 'comp,eq' && studio.track(${track}).fx.size === 2`));

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
