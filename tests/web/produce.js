// Production mode: clip view, timeline, browser drag and drop, launching in time, following
// the Perform tab's tempo, the mixer's faders and meters, Tap and Key, undo. Fails on any page error or a check that doesn't hold.
// Run against a running Crate with at least one sample folder added (POST /api/samples/folder):
//   BASE=http://127.0.0.1:47800 node tests/web/produce.js [screenshot dir]
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = []; p.on('pageerror', (e) => errs.push('PAGE ' + String(e))); p.on('console', (m) => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
  const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${info}`); if (!ok) errs.push(name); };
  const S = (fn, arg) => p.evaluate(async ([src, a]) => { const e = await import('/js/produce/engine.js'), s = await import('/js/produce/set.js'); return new Function('studio', 'P', 'a', src)(e.studio, s.P, a); }, [fn, arg]);
  const wait = (ms) => p.waitForTimeout(ms);
  const row = (name) => p.locator('.pb-row', { hasText: name });

  await p.goto(BASE); await p.waitForSelector('#rows .r');
  await p.evaluate(() => fetch('/api/project/new', { method: 'POST', body: '{}' }));
  await p.click('#mProd'); await p.waitForSelector('.pc-track'); await wait(600);
  check('new set is empty', await S('return P.set.tracks.length === 4 && P.set.tracks.every((t) => !Object.keys(t.clips).length)'));
  await p.screenshot({ path: `${OUT}/produce-empty.png` });

  // browser: samples listed, Drums narrows, search narrows
  check('samples listed', (await p.locator('.pb-row').count()) >= 4);
  await p.click('.pb-place >> text=Drums'); await wait(100);
  check('drums category', (await p.locator('.pb-row').count()) === 3 && !(await row('Bass Groove').count()));
  await p.click('.pb-place >> text=Samples'); await p.fill('.pb-search input', 'loop 124'); await wait(100);
  check('search', (await p.locator('.pb-row').count()) === 1);
  await p.fill('.pb-search input', ''); await wait(100);

  // drag a loop and a kick into the audio tracks' first slots
  await row('Drum Loop 124').dragTo(p.locator('.pc-track >> nth=2').locator('.pc-slot >> nth=0')); await wait(600);
  await row('Bass Groove').dragTo(p.locator('.pc-track >> nth=3').locator('.pc-slot >> nth=0')); await wait(600);
  await row('Kick 01').dragTo(p.locator('.pc-drop')); await wait(600);
  const clips = await S('return P.set.tracks.flatMap((t) => Object.values(t.clips).map((c) => [c.name, c.bpm && +c.bpm.toFixed(2), c.beats, c.loop]))');
  console.log('clips', JSON.stringify(clips));
  check('loop tempo from name', clips.some(([n, bpm, beats]) => n.startsWith('Drum Loop') && bpm === 124 && beats === 8));
  check('loop fitted to bars', clips.some(([n, , beats]) => n === 'Bass Groove' && beats === 16));
  check('one-shot', clips.some(([n, , , loop]) => n === 'Kick 01' && loop === false));
  check('drop on empty space adds a track', await S('return P.set.tracks.length === 5'));

  // launch a scene: both loops start together on the next bar
  await p.click('.pc-scene >> nth=0'); await wait(2600);
  const st = await S('return P.set.tracks.slice(2, 4).map((t) => { const s = studio.state(t); return [!!s.playing, s.start]; })');
  check('scene launched on a bar', st.every(([on, at]) => on && at % 4 === 0), JSON.stringify(st));
  check('sound out', (await S('return (async () => { let m = 0; for (let i = 0; i < 20; i++) { m = Math.max(m, studio.mainMeter()); await new Promise((r) => setTimeout(r, 30)); } return m; })()')) > 0.01);  // over 600 ms: a loop has gaps
  await p.screenshot({ path: `${OUT}/produce-clips.png` });
  await p.click('.pc-stop >> text=Stop all'); await wait(2200);
  check('stop all', await S('return !studio.busy'));

  // timeline: drop the loop at bar 3, play from the marker, the playhead moves
  await p.keyboard.press('Tab'); await p.waitForSelector('.pt-lanes'); await wait(300);
  const lanes = await p.locator('.pt-lanes').boundingBox();
  await row('Drum Loop 124').dragTo(p.locator('.pt-lanes'), { targetPosition: { x: 8 * 10 + 3, y: 2 * 68 + 20 } }); await wait(600);
  await row('Bass Groove').dragTo(p.locator('.pt-lanes'), { targetPosition: { x: 3, y: 3 * 68 + 20 } }); await wait(600);
  const arr = await S('return P.set.arrangement.map((a) => [a.track, a.start, a.length])');
  check('timeline drop snapped to the bar', JSON.stringify(arr) === JSON.stringify([[3, 8, 8], [4, 0, 16]]), JSON.stringify(arr));
  // drag the bass clip one bar right
  await p.mouse.move(lanes.x + 40, lanes.y + 3 * 68 + 30); await p.mouse.down(); await p.mouse.move(lanes.x + 80, lanes.y + 3 * 68 + 30, { steps: 5 }); await p.mouse.up(); await wait(200);
  check('clip moved by a bar', await S('return P.set.arrangement[1].start === 4'), JSON.stringify(await S('return P.set.arrangement[1]')));
  await p.keyboard.press('Control+z'); await wait(200);
  check('undo', await S('return P.set.arrangement[1].start === 0'));
  await p.keyboard.press('Space'); await wait(3000);
  const head = await S('return studio.songBeat()');
  check('timeline plays', head > 1, head);
  await p.screenshot({ path: `${OUT}/produce-timeline.png` });
  await p.keyboard.press('Space'); await wait(300);
  check('space stops', await S('return !studio.song'));

  // the mixer: a fader dragged a quarter of its way down, reset by double-click; Main metered on both sides
  await p.keyboard.press('Tab'); await wait(300);
  const f = p.locator('.pc-track').nth(0).locator('.pc-fader'), fb = await f.boundingBox();
  await p.mouse.move(fb.x + fb.width / 2, fb.y + 30); await p.mouse.down(); await p.mouse.move(fb.x + fb.width / 2, fb.y + 30 + (fb.height - 12) * 0.25, { steps: 5 }); await p.mouse.up(); await wait(100);
  check('dragging a fader down lowers its track', await S('return Math.abs(P.set.tracks[0].volume - 0.6) < 0.01'), String(await S('return P.set.tracks[0].volume')));
  await f.dblclick(); await wait(100);
  check('double-clicking the fader resets it to 0 dB', await S('return P.set.tracks[0].volume === 0.85'));
  await p.keyboard.press('Space'); await wait(1500);
  let sides = [0, 0];
  for (let i = 0; i < 20; i++) { const l = await S('return studio.stripOf(P.set.main).levels()'); sides = sides.map((v, j) => Math.max(v, l[j] || 0)); await wait(30); }
  check("Main's meter reads both sides", sides.length === 2 && sides.every((v) => v > 0.02), JSON.stringify(sides));
  await p.keyboard.press('Space'); await wait(300);
  // Tap: five taps half a second apart make 120 BPM; Key: A minor from the menu
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) { await p.locator('.pt-tap').click(); await wait(t0 + 500 * (i + 1) - Date.now()); }
  check('tap tempo', await S('return Math.abs(P.set.bpm - 120) < 4'), String(await S('return P.set.bpm')));
  await p.locator('.pt-key').click(); await p.getByRole('menuitem', { name: 'Minor' }).click(); await p.getByRole('menuitem', { name: 'A', exact: true }).click(); await wait(200);
  check("the set's key, with what's in it", (await p.locator('.pt-key').textContent()).includes('Am') && await p.evaluate(async () => { const s = await import('/js/produce/set.js'); return s.inKey(57) && s.inKey(60) && !s.inKey(61); }));

  // follow the Perform tab: a playing deck sets the tempo
  const id = await p.evaluate(async () => (await import('/js/state.js')).S.rows.find((t) => t.bpm).id);
  await p.click('#mPerf'); await wait(800);
  const bpm = await p.evaluate(async (id) => { const m = await import('/js/perform/index.js'); await m.loadTo('A', id); m.engine.deck('A').togglePlay(); await new Promise((r) => setTimeout(r, 1200)); return m.engine.deck('A').bpm; }, id);
  await p.click('#mProd'); await wait(400);
  const t = await S('return studio.tempo()');
  check('tempo follows the deck', Math.abs(t - bpm) < 0.01, `${t} vs ${bpm}`);
  await p.screenshot({ path: `${OUT}/produce-follow.png` });

  // saved: a reload brings the set back
  await wait(800); await p.reload(); await p.waitForSelector('.pt-lanes, .pc-track'); await wait(500);
  check('saved across reload', await S('return P.set.arrangement.length === 2 && P.set.tracks.length === 5'));

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
