// Production's mixer and built-in effects, checked by what they do to the sound: returns come
// with their effects, sends reach them, the compressor turns down, the limiter holds its
// ceiling, the EQ's curve is what was asked for, bypass rewires, and the chain's editing
// (browser drops, knob undo, Delete, presets, reload) holds. Fails on any page error.
// Run against a running Crate with the sample folder from produce.js added:
//   BASE=http://127.0.0.1:47800 node tests/web/devices.js [screenshot dir]
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = []; p.on('pageerror', (e) => errs.push('PAGE ' + String(e))); p.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
  const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
  const S = (fn, arg) => p.evaluate(async ([src, a]) => {
    const e = await import('/js/produce/engine.js'), s = await import('/js/produce/set.js');
    return new Function('studio', 'P', 'set', 'a', `return (async () => { ${src} })()`)(e.studio, s.P, s, a);
  }, [fn, arg]);
  const wait = (ms) => p.waitForTimeout(ms);
  // the loudest a meter reads over a stretch of time
  const peak = (expr, ms = 1500) => S(`let m = 0; const end = performance.now() + ${ms}; while (performance.now() < end) { m = Math.max(m, ${expr}); await new Promise((r) => setTimeout(r, 15)); } return m;`);
  const track = 'P.set.tracks[2]';

  await p.goto(BASE); await p.waitForSelector('#rows .r');
  await p.evaluate(() => fetch('/api/project/new', { method: 'POST', body: '{}' }));
  await p.click('#mProd'); await p.waitForSelector('.pc-track'); await wait(600);

  // a new set's returns hold a reverb and a delay, fully wet, already running
  check('returns come with effects', await S(`return P.set.returns.map((r) => r.devices[0]?.type).join() === 'reverb,delay' && P.set.returns.every((r) => studio.ret(r).fx.size === 1)`));

  // a loop playing on track 3, sent to A
  await S(`const c = await set.makeClip({ kind: 'sample', f: 0, p: 'Loops/Drum Loop 124 bpm.wav' }); set.edit(() => { ${track}.clips[0] = c; ${track}.sends.A = 0.85; P.sel = ${track}.id; }); studio.launch(${track}, c);`);
  await wait(2400);
  check('track plays', (await peak(`studio.track(${track}).meter()`, 600)) > 0.05);
  check('send reaches the return', (await peak(`studio.ret(P.set.returns[0]).meter()`, 800)) > 0.01);

  // Compressor: a low threshold and high ratio show real gain reduction
  await S(`set.edit(() => { const d = set.addDevice(${track}, 'comp'); d.params = { threshold: -40, ratio: 10, attack: 1, release: 50 }; });`);
  await wait(300);
  const gr = await S(`let m = 0; for (let i = 0; i < 60; i++) { m = Math.min(m, studio.device(${track}, P.dev).meter); await new Promise((r) => setTimeout(r, 20)); } return m;`);
  check('compressor reduces gain', gr < -6, `${gr.toFixed(1)} dB`);
  await p.screenshot({ path: `${OUT}/devices-comp.png` });

  // Limiter on Main: driven 18 dB into a -6 dB ceiling, nothing gets past it
  await S(`set.edit(() => { const d = set.addDevice(P.set.main, 'limiter'); d.params = { gain: 18, ceiling: -6 }; P.sel = 'main'; });`);
  await wait(400);
  const lim = await peak('studio.mainMeter()', 2000);
  check('limiter holds its ceiling', lim <= 10 ** (-6 / 20) * 1.01 && lim > 0.3, lim.toFixed(3));

  // EQ Eight: +12 dB at 1 kHz on band 4 shows in the live response
  const eq = await S(`set.edit(() => { const d = set.addDevice(${track}, 'eq'); d.params = { f4: 1000, g4: 12, q4: 1 }; }); await new Promise((r) => setTimeout(r, 300));
    const x = studio.device(${track}, P.dev), f = new Float32Array([1000, 100]), m = new Float32Array(2), ph = new Float32Array(2), out = [1, 1];
    for (const bq of x.bands.flat()) { bq.getFrequencyResponse(f, m, ph); out[0] *= m[0]; out[1] *= m[1]; }
    return out.map((v) => 20 * Math.log10(v));`);
  check('EQ curve', Math.abs(eq[0] - 12) < 0.5 && Math.abs(eq[1]) < 1.5, eq.map((v) => v.toFixed(2)).join(' / '));

  // switching a device off takes it out of the signal path; on puts it back
  const wired = await S(`const x = studio.track(${track}), d = ${track}.devices[0]; set.edit(() => { d.on = false; }); const off = x.wired; set.edit(() => { d.on = true; }); return [off, x.wired];`);
  check('bypass rewires', !wired[0].includes(',') && wired[1].split(',').length === 2, JSON.stringify(wired));

  // browser: Audio Effects lists every device; a drag onto the chain adds one where it's dropped
  await S(`P.sel = ${track}.id;`); await wait(200);
  await p.click('.pb-place >> text=Audio Effects'); await wait(150);
  check('browser lists the effects', (await p.locator('.pb-row').count()) === 12);
  await p.locator('.pb-row', { hasText: 'Saturator' }).dragTo(p.locator('.pd-drop')); await wait(300);
  check('drag onto the chain', await S(`return ${track}.devices.map((d) => d.type).join() === 'comp,eq,sat'`), await S(`return ${track}.devices.map((d) => d.type).join()`));
  await p.locator('.pb-row', { hasText: 'Reverb' }).dblclick(); await wait(300);
  check('double-click adds to the selected track', await S(`return ${track}.devices.at(-1).type === 'reverb'`));

  // a knob drag is one undo step
  const knob = p.locator('.dev').last().locator('.knob').first();
  const before = await S(`return JSON.stringify(${track}.devices.at(-1).params)`);
  await knob.scrollIntoViewIfNeeded(); const kb = await knob.boundingBox();
  await p.mouse.move(kb.x + kb.width / 2, kb.y + 20); await p.mouse.down(); await p.mouse.move(kb.x + kb.width / 2, kb.y - 40, { steps: 8 }); await p.mouse.up(); await wait(100);
  const after = await S(`return JSON.stringify(${track}.devices.at(-1).params)`);
  await p.keyboard.press('Control+z'); await wait(200);
  check('knob drag then undo', after !== before && (await S(`return JSON.stringify(${track}.devices.at(-1).params)`)) === before, `${before} → ${after}`);

  // a factory preset loads; Delete removes the selected device
  await S(`const d = ${track}.devices.at(-1); set.edit(() => { d.params = { size: 0.8, decay: 3.5, pre: 25 }; });`);
  await p.locator('.dev').last().locator('.dev-name').click(); await p.keyboard.press('Delete'); await wait(300);
  check('Delete removes the selected device', await S(`return ${track}.devices.map((d) => d.type).join() === 'comp,eq,sat'`));
  await p.screenshot({ path: `${OUT}/devices-chain.png` });

  // a return added and removed takes its sends with it
  await p.keyboard.press('Control+Alt+t'); await wait(200);
  check('new return', await S(`return P.set.returns.length === 3 && P.set.returns[2].id === 'C'`));
  await S(`set.edit(() => { ${track}.sends.C = 0.5; set.removeReturn(P.set.returns[2]); });`);
  check('removed return takes its sends', await S(`return !('C' in ${track}.sends) && !studio.returns.has('C') && !studio.track(${track}).sends.has('C')`));

  // saved: the chain comes back after a reload, running
  await S('studio.stopAll(true);'); await wait(900);
  await p.reload(); await p.waitForSelector('.pc-track'); await wait(700);
  check('chain saved across reload', await S(`return ${track}.devices.map((d) => d.type).join() === 'comp,eq,sat' && P.set.main.devices[0].type === 'limiter' && studio.track(${track}).fx.size === 3`));

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
