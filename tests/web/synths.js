// The synth editors, through the page as they're used: open each instrument's window from its
// device, play its keyboard and hear it stop when let go, turn a knob, drag the envelope, step
// through presets, undo, move and scale the window; the window outlives redraws and undo, hides
// on other tabs, and closes when its device goes.
// NATIVE=1 runs it on the native engine (start Crate with a studio-capable CRATE_ENGINE).
//   BASE=http://127.0.0.1:47800 [NATIVE=1] node tests/web/synths.js [screenshot dir]
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.', NATIVE = !!process.env.NATIVE;
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  if (NATIVE) await p.addInitScript(() => localStorage.setItem('perf', JSON.stringify({ engine: 'native', api: 'null', buffer: 256 })));
  const errs = []; p.on('pageerror', (e) => errs.push('PAGE ' + String(e))); p.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
  const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
  const S = (src) => p.evaluate(async (s) => {
    const e = await import('/js/produce/engine.js'), m = await import('/js/produce/set.js');
    return new Function('studio', 'P', 'set', `return (async () => { ${s} })()`)(e.studio, m.P, m);
  }, src);
  const wait = (ms) => p.waitForTimeout(ms);
  const loud = async (ms) => { let m = 0; for (const end = Date.now() + ms; Date.now() < end;) { m = Math.max(m, await S('return studio.mainMeter()')); await wait(30); } return m; };
  const dev = (k) => S(`return P.set.tracks[0].devices[0].${k}`);
  const param = (k) => S(`return P.set.tracks[0].devices[0].params.${k}`);

  await p.goto(BASE); await p.waitForSelector('#rows .r');
  await p.evaluate(() => fetch('/api/project/new', { method: 'POST', body: '{}' })); await p.reload(); await p.waitForSelector('#rows .r');
  await p.keyboard.press('F7'); await p.waitForSelector('.pc-track'); await wait(1200);
  check(`runs on the ${NATIVE ? 'native' : 'browser'} engine`, await S(`return studio.native === ${NATIVE}`));

  for (const type of ['fm', 'add', 'grain', 'drum']) {
    if (type !== 'fm') { await S(`set.edit(() => set.addDevice(P.set.tracks[0], '${type}'));`); await wait(300); }
    await p.locator('.dev.instrument .dev-edit').first().click(); await wait(500);
    const win = p.locator('.sx');
    check(`${type}: its editor opens over the set`, (await win.count()) === 1 && await win.isVisible());
    // the keyboard: held, it sounds; let go, it stops
    const key = p.locator('.sx-kb [data-p="48"]'), kb = await key.boundingBox();
    await p.mouse.move(kb.x + kb.width / 2, kb.y + kb.height * 0.8); await p.mouse.down();
    check(`${type}: a key held on its keyboard plays it`, (await loud(700)) > 0.02);
    await p.mouse.up(); await wait(type === 'grain' || type === 'add' ? 2500 : 1500);
    check(`${type}: let go, it stops`, (await loud(400)) < 0.003);
    await p.screenshot({ path: `${OUT}/synth-${type}.png` });
    await p.locator('.sx .sx-ib.close').click(); await wait(200);
    check(`${type}: closes`, (await win.count()) === 0);
  }

  // the rest on Crate FM: put it back alone on the track
  await S("set.edit(() => { P.set.tracks[0].devices = []; set.addDevice(P.set.tracks[0], 'fm'); });"); await wait(300);
  await p.locator('.dev.instrument').first().locator('.dev-head').dblclick(); await wait(500);
  check('double-clicking an instrument\'s title opens its editor', (await p.locator('.sx').count()) === 1);

  // a knob: Op A's ratio dragged up
  const ratio = p.locator('.sx-op').first().locator('.knob').nth(1), rb = await ratio.boundingBox();
  await p.mouse.move(rb.x + rb.width / 2, rb.y + 12); await p.mouse.down(); await p.mouse.move(rb.x + rb.width / 2, rb.y - 40, { steps: 6 }); await p.mouse.up(); await wait(100);
  check("a knob in the editor sets the synth's parameter", (await param('aratio')) > 1, String(await param('aratio')));
  // the envelope: the peak dragged right lengthens the attack, the knee down lowers the sustain
  const env = p.locator('.sx-env').first(), eb = await env.boundingBox();
  const pts = await env.evaluate((c) => { const r = c.getBoundingClientRect(); return [r.width / c.clientWidth, r.height / c.clientHeight]; });
  const where = () => p.evaluate(async () => {
    const { envPoints } = await import('/js/produce/instruments/panels.js'), m = await import('/js/produce/set.js'), c = document.querySelector('.sx-env'), d = m.P.set.tracks[0].devices[0].params;
    return envPoints(c.clientWidth, c.clientHeight, d.aa ?? 0.002, d.ad ?? 0.3, d.as ?? 1, d.ar ?? 0.25);
  });
  let pt = await where();
  await p.mouse.move(eb.x + pt.x1 * pts[0], eb.y + pt.top * pts[1]); await p.mouse.down(); await p.mouse.move(eb.x + pt.x1 * pts[0] + 60, eb.y + pt.top * pts[1], { steps: 6 }); await p.mouse.up(); await wait(100);
  check('dragging the envelope\'s peak lengthens the attack', (await param('aa')) > 0.05, String(await param('aa')));
  pt = await where();
  await p.mouse.move(eb.x + pt.x2 * pts[0], eb.y + pt.ys * pts[1]); await p.mouse.down(); await p.mouse.move(eb.x + pt.x2 * pts[0], eb.y + pt.ys * pts[1] + 40, { steps: 6 }); await p.mouse.up(); await wait(100);
  check('dragging its knee down lowers the sustain', (await param('as')) < 0.9, String(await param('as')));

  // presets: the arrow steps to the first, then the next; undo goes back, and the window stays
  await p.locator('.sx .sx-ib[aria-label="Next preset"]').click(); await wait(150);
  const first = await dev('preset');
  await p.locator('.sx .sx-ib[aria-label="Next preset"]').click(); await wait(150);
  const second = await dev('preset');
  check('the preset arrows step through the presets', !!first && !!second && first !== second && (await p.locator('.sx-pname').textContent()).includes(second), `${first} → ${second}`);
  await p.locator('.sx .sx-ib[aria-label="Undo"]').click(); await wait(300);
  check('undo in the editor takes the preset back, and the window stays', await dev('preset') === first && (await p.locator('.sx').count()) === 1 && (await p.locator('.sx-pname').textContent()).includes(first));

  // the matrix page
  await p.locator('.sx-ptab', { hasText: 'MATRIX' }).click(); await wait(200);
  check('the matrix page shows six slots', (await p.locator('.sx-matrix .fs-slot').count()) === 6 && await p.locator('.sx-matrix').isVisible());
  await p.locator('.sx-ptab', { hasText: 'OSC' }).click(); await wait(200);

  // moved by its header, scaled from its corner
  const before = await p.locator('.sx').boundingBox(), hb = await p.locator('.sx-brand').boundingBox();
  await p.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2); await p.mouse.down(); await p.mouse.move(hb.x + hb.width / 2 - 100, hb.y + hb.height / 2 + 50, { steps: 6 }); await p.mouse.up();
  const after = await p.locator('.sx').boundingBox();
  check('dragging the header moves the window', Math.abs(after.x - before.x + 100) < 3 && Math.abs(after.y - before.y - 50) < 3, `${before.x},${before.y} → ${after.x},${after.y}`);
  const g = await p.locator('.sx-grip').boundingBox();
  await p.mouse.move(g.x + 5, g.y + 5); await p.mouse.down(); await p.mouse.move(g.x - 200, g.y - 100, { steps: 6 }); await p.mouse.up();
  check('dragging the corner scales it', (await p.locator('.sx').boundingBox()).width < after.width - 100);

  // other tabs hide it; deleting the synth closes it
  await p.keyboard.press('F6'); await wait(300);
  check('hidden on the other tabs', !(await p.locator('.sx').isVisible()));
  await p.keyboard.press('F7'); await wait(300);
  check('back in Produce, it\'s there', await p.locator('.sx').isVisible());
  await S("set.edit(() => { P.set.tracks[0].devices = []; });"); await wait(300);
  check('deleting the synth closes its window', (await p.locator('.sx').count()) === 0);

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
