// Group tracks in Produce, checked by what's heard: picking and Ctrl+G, folding in both views,
// the group's fader and mute over its tracks, solo either way, Audio To in and out, nesting, ungrouping, deleting,
// undo and reload. NATIVE=1 runs it on the native engine (start Crate with a studio-capable
// CRATE_ENGINE); otherwise on the browser's. Needs the sample folder from produce.js.
//   BASE=http://127.0.0.1:47800 [NATIVE=1] node tests/web/groups.js [screenshot dir]
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.', NATIVE = !!process.env.NATIVE;
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  if (NATIVE) await p.addInitScript(() => localStorage.setItem('perf', JSON.stringify({ engine: 'native', api: 'null', buffer: 256 })));
  const errs = []; p.on('pageerror', (e) => errs.push('PAGE ' + String(e))); p.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
  const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
  const S = (fn) => p.evaluate(async (src) => {
    const e = await import('/js/produce/engine.js'), s = await import('/js/produce/set.js');
    return new Function('studio', 'P', 'set', `return (async () => { ${src} })()`)(e.studio, s.P, s);
  }, fn);
  const wait = (ms) => p.waitForTimeout(ms);
  const loud = (expr, ms = 700) => S(`let m = 0; const end = performance.now() + ${ms}; while (performance.now() < end) { m = Math.max(m, ${expr}); await new Promise((r) => setTimeout(r, 30)); } return m;`);
  const main = () => loud('studio.mainMeter()');
  const heads = () => p.locator('.pc-track .pc-head');

  await p.goto(BASE); await p.waitForSelector('#rows .r');
  await p.evaluate(() => fetch('/api/project/new', { method: 'POST', body: '{}' }));
  await p.click('#mProd'); await p.waitForSelector('.pc-track'); await wait(900);
  check(`runs on the ${NATIVE ? 'native' : 'browser'} engine`, await S(`return studio.native === ${NATIVE}`));

  // pick tracks 3 and 4 (click, Ctrl-click) and group them
  await heads().nth(2).click(); await heads().nth(3).click({ modifiers: ['Control'] });
  await p.keyboard.press('Control+g'); await wait(300);
  const shape = await S(`return P.set.tracks.map((t) => (t.kind === 'group' ? 'G' : t.group ? 'g' + t.name[0] : t.name[0])).join()`);
  check('Ctrl+G groups the picked tracks', shape === '1,2,G,g3,g4', shape);
  check('the group has its column', (await p.locator('.pc-group').count()) === 1);

  // a loop on track 3, playing through the group
  await S(`const t = P.set.tracks.find((x) => x.name.startsWith('3')), c = await set.makeClip({ kind: 'sample', f: 0, p: 'Loops/Drum Loop 124 bpm.wav' }); set.edit(() => { t.clips[0] = c; }); studio.launch(t, c);`);
  await wait(2600);
  check('a grouped track plays through its group', (await loud(`studio.track(P.set.tracks[2]).meter()`)) > 0.05 && (await main()) > 0.05);
  await S(`const g = P.set.tracks[2]; set.edit(() => { g.mute = true; });`); await wait(300);
  check('muting the group silences its tracks', (await main()) < 0.002);
  await S(`const g = P.set.tracks[2]; set.edit(() => { g.mute = false; g.volume = 0; });`); await wait(300);
  check("the group's fader is its tracks' level", (await main()) < 0.002);
  await S(`const g = P.set.tracks[2]; set.edit(() => { g.volume = 0.85; });`); await wait(300);

  // solo: another track soloed silences the group; the group soloed brings its tracks back
  await S(`set.edit(() => { P.set.tracks[0].solo = true; });`); await wait(300);
  check('solo elsewhere silences the group', (await main()) < 0.002);
  await S(`set.edit(() => { P.set.tracks[0].solo = false; P.set.tracks[2].solo = true; });`); await wait(300);
  check('soloing the group keeps its tracks', (await main()) > 0.05);
  await S(`set.edit(() => { P.set.tracks[2].solo = false; P.set.tracks[3].solo = true; });`); await wait(300);
  check('soloing a track keeps its group up', (await main()) > 0.05);
  await S(`set.edit(() => { P.set.tracks[3].solo = false; });`);

  // Audio To: track 3 straight to Main skips the group; back in, the group's mute holds it again
  const io = () => p.locator('.pc-track', { hasText: '3 Audio' }).locator('.pc-io');
  await io().click(); await p.locator('.menu [role=menuitem]', { hasText: 'Main' }).click(); await wait(300);
  check('Audio To Main takes a track out of its group', await S(`const t = P.set.tracks.find((x) => x.name.startsWith('3')); return !t.group && P.set.tracks.indexOf(t) === 4`) && (await io().textContent()) === 'Main');
  await S(`set.edit(() => { P.set.tracks[2].mute = true; });`); await wait(300);
  check('and plays past the muted group', (await main()) > 0.05);
  await io().click(); await p.locator('.menu [role=menuitem]', { hasText: 'Group' }).click(); await wait(300);
  check('Audio To a group puts it back in', (await main()) < 0.002 && (await io().textContent()) === 'Group');
  for (let i = 0; i < 3; i++) await p.keyboard.press('Control+z');
  await wait(300);
  const back = await S(`return P.set.tracks.map((t) => (t.kind === 'group' ? 'G' : t.group ? 'g' + t.name[0] : t.name[0])).join()`);
  check('undo walks it back', back === '1,2,G,g3,g4', back);

  // folding hides the tracks in both views
  await p.locator('.pc-group .pc-fold').click(); await wait(200);
  check('folded: the tracks hide', (await p.locator('.pc-track').count()) === 2 + 1 + 2 + 1, String(await p.locator('.pc-track').count()));
  await p.screenshot({ path: `${OUT}/groups-folded.png` });
  await p.click('text=Timeline'); await wait(300);
  check('timeline folds too', (await p.locator('.pt-head:not(.pt-strip)').count()) === 3);
  await p.screenshot({ path: `${OUT}/groups-timeline.png` });
  await p.click('text=Clips'); await p.locator('.pc-group .pc-fold').click(); await wait(200);

  // nesting: the group and track 1 into a new group; still heard
  await heads().nth(0).click(); await p.locator('.pc-group .pc-head').first().click({ modifiers: ['Control'] });
  await p.keyboard.press('Control+g'); await wait(400);
  const nested = await S(`return P.set.tracks.map((t) => [t.kind === 'group' ? 'G' : t.name[0], t.group ? P.set.tracks.findIndex((x) => x.id === t.group) : -1].join(':')).join()`);
  check('groups nest', nested === 'G:-1,1:0,G:0,3:2,4:2,2:-1', nested);
  check('heard through two groups', (await main()) > 0.05);

  // ungroup the outer one, then delete the inner with its tracks; undo brings them back
  await p.locator('.pc-group .pc-head').first().click(); await p.keyboard.press('Control+Shift+g'); await wait(300);
  check('ungroup keeps the tracks', await S(`return P.set.tracks.filter((t) => t.kind === 'group').length === 1 && P.set.tracks.length === 5`));
  check('heard after ungrouping', (await main()) > 0.05);
  await S(`set.edit(() => set.removeTrack(P.set.tracks.find((t) => t.kind === 'group')));`); await wait(300);
  check('deleting a group deletes its tracks', await S(`return P.set.tracks.length === 2 && !P.set.tracks.some((t) => t.kind === 'group')`));
  check('and they stop', (await main()) < 0.002);
  await p.keyboard.press('Control+z'); await wait(300);
  check('undo brings the group back', await S(`return P.set.tracks.length === 5 && P.set.tracks.some((t) => t.kind === 'group')`));

  // saved: the group survives a reload, routed
  await S('studio.stopAll(true);'); await wait(900);
  await p.reload(); await p.waitForSelector('.pc-track'); await wait(1200);
  check('groups saved', await S(`return P.set.tracks.filter((t) => t.group).length === 2`));
  await S(`const t = P.set.tracks.find((x) => x.clips[0]); studio.launch(t, t.clips[0]);`); await wait(2600);
  check('and play after reload', (await main()) > 0.05);

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
