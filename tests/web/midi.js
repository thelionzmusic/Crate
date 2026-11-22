// MIDI clips and the piano roll, through the page as it's used: double-click a slot to make a
// clip, draw, move, resize, edit by keyboard and velocity, change its length, undo; then hear it
// play from its slot and from the timeline, load a preset from the browser, and reload.
// NATIVE=1 runs it on the native engine (start Crate with a studio-capable CRATE_ENGINE).
//   BASE=http://127.0.0.1:47800 [NATIVE=1] node tests/web/midi.js [screenshot dir]
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.', NATIVE = !!process.env.NATIVE;
const KEYS = 46, RULER = 18, VEL = 46, ROW = 11;  // the piano roll's geometry (pianoroll.js)
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
  const loud = (ms = 700) => S(`let m = 0; const end = performance.now() + ${ms}; while (performance.now() < end) { m = Math.max(m, studio.mainMeter()); await new Promise((r) => setTimeout(r, 30)); } return m;`);
  const notes = () => S('return set.clipAt(P.open).clip.notes.map((n) => [n.p, n.s, n.l, n.v])');

  await p.goto(BASE); await p.waitForSelector('#rows .r');
  await p.evaluate(() => fetch('/api/project/new', { method: 'POST', body: '{}' }));
  await p.keyboard.press('F7'); await p.waitForSelector('.pc-track'); await wait(1200);
  check(`runs on the ${NATIVE ? 'native' : 'browser'} engine`, await S(`return studio.native === ${NATIVE}`));
  check('a new MIDI track has Crate FM', await S("return P.set.tracks[0].devices[0]?.type === 'fm'"));

  // a clip from an empty slot, open in the roll
  await p.locator('.pc-track').nth(0).locator('.pc-slot').nth(0).dblclick(); await wait(400);
  check('double-clicking an empty MIDI slot makes a clip and opens it', await S("return P.detail === 'clip' && set.clipAt(P.open)?.clip.beats === 4") && await p.locator('.pr-canvas').isVisible());
  const box = await p.locator('.pr-canvas').boundingBox(), zoom = (box.width - KEYS - 12) / 4, top = (127 - 60) * ROW - (box.height - RULER - VEL) / 2;
  const at = (beat, pitch) => [box.x + KEYS + beat * zoom + 3, box.y + RULER + (127 - pitch) * ROW - top + ROW / 2];

  // draw: double-click places a sixteenth on the grid
  for (const [beat, pitch] of [[0, 60], [1, 64], [2, 65], [3, 67]]) { const [x, y] = at(beat, pitch); await p.mouse.dblclick(x, y); await wait(60); }
  check('notes drawn on the grid', JSON.stringify(await notes()) === JSON.stringify([[60, 0, 0.25, 100], [64, 1, 0.25, 100], [65, 2, 0.25, 100], [67, 3, 0.25, 100]]), JSON.stringify(await notes()));

  // drag the first note a beat right and up a tone; drag its end out to a beat
  let [x, y] = at(0, 60); await p.mouse.move(x + 2, y); await p.mouse.down(); await p.mouse.move(x + 2 + zoom, y - 2 * ROW, { steps: 6 }); await p.mouse.up(); await wait(100);
  check('a note moves', (await notes())[0].join() === '62,1,0.25,100', (await notes())[0].join());
  [x, y] = at(1.25, 62); await p.mouse.move(x - 4, y); await p.mouse.down(); await p.mouse.move(x - 4 + zoom * 0.75, y, { steps: 6 }); await p.mouse.up(); await wait(100);
  check('its end drags out', (await notes())[0][2] === 1, (await notes())[0].join());

  // keys: everything up a semitone, duplicated after itself, then the copies removed by undo
  await p.keyboard.press('Control+a'); await p.keyboard.press('ArrowUp'); await wait(100);
  check('arrow up transposes the selection', (await notes()).map((n) => n[0]).join() === '63,65,66,68', (await notes()).map((n) => n[0]).join());
  await p.keyboard.press('Control+d'); await wait(100);
  check('Ctrl+D repeats the selection a bar on', (await notes()).length === 8 && (await notes())[4][1] === 5, JSON.stringify((await notes())[4]));
  await p.keyboard.press('Control+z'); await wait(100);
  check('undo takes the copies back', (await notes()).length === 4);

  // velocity: drag a stem down
  [x] = at(1, 63); await p.mouse.move(x - 3, box.y + box.height - 20); await p.mouse.down(); await p.mouse.move(x - 3, box.y + box.height - 5, { steps: 4 }); await p.mouse.up(); await wait(100);
  check('velocity drags', (await notes())[0][3] < 100, String((await notes())[0][3]));

  // ×2 doubles the clip with its notes; Delete on a selection removes it
  await p.locator('.pr-side button', { hasText: '×2' }).click(); await wait(100);
  check('×2 doubles the clip and its notes', await S('return set.clipAt(P.open).clip.beats === 8') && (await notes()).length === 8);
  await p.locator('.pr-canvas').click({ position: { x: KEYS + 5, y: RULER + 3 } });  // focus without selecting
  await p.keyboard.press('Control+a'); await p.keyboard.press('Delete'); await wait(100);
  check('Delete removes the selected notes', (await notes()).length === 0);
  await p.keyboard.press('Control+z'); await wait(100);
  await p.screenshot({ path: `${OUT}/midi-roll.png` });

  // heard: launched from its slot's ▶, through Crate FM; stopped, it falls silent
  await p.locator('.pc-track').nth(0).locator('.pc-go').first().click(); await wait(2600);
  check('the clip plays through its instrument', (await loud(1500)) > 0.05);
  await S('studio.stopAll(true);'); await wait(800);
  check('stopped, nothing hangs', (await loud(400)) < 0.002);

  // the timeline: double-click an empty MIDI lane for a clip there, draw in it, play it
  await p.keyboard.press('Tab'); await wait(400);
  const lanes = await p.locator('.pt-lanes').boundingBox();
  await p.mouse.dblclick(lanes.x + 10 * 4 * 2 + 5, lanes.y + 68 + 30); await wait(400);  // bar 3 of track 2
  check('double-clicking a MIDI lane makes a clip there', await S('const a = P.set.arrangement[0]; return a && a.track === P.set.tracks[1].id && a.start === 8 && !!a.clip.notes && P.open?.item === 0'));
  const box2 = await p.locator('.pr-canvas').boundingBox(), zoom2 = (box2.width - KEYS - 12) / 4;
  await p.mouse.dblclick(box2.x + KEYS + 3, box2.y + RULER + (127 - 60) * ROW - ((127 - 60) * ROW - (box2.height - RULER - VEL) / 2) + ROW / 2);
  await p.locator('.pr-side button', { hasText: 'Draw' }).click();
  for (let i = 1; i < 4; i++) await p.mouse.click(box2.x + KEYS + i * zoom2 + 3, box2.y + RULER + ((box2.height - RULER - VEL) / 2) + ROW / 2);
  check('Draw mode places a note per click', (await notes()).length === 4, JSON.stringify(await notes()));
  await S('studio.playSong(8);'); await wait(300);
  check('the timeline plays it', (await loud(3200)) > 0.05);  // it starts on the next bar and lasts one: listen across both
  await S('studio.stopSong(); studio.stopAll(true);'); await wait(600);
  await p.screenshot({ path: `${OUT}/midi-timeline.png` });

  // a preset from the browser onto the selected track
  await p.locator('.pb-place', { hasText: 'Instruments' }).click(); await wait(200);
  check('the browser lists the presets', (await p.locator('.pb-row.preset').count()) >= 100, String(await p.locator('.pb-row.preset').count()));
  await p.locator('.pb-row.preset', { hasText: /^808$/ }).dblclick(); await wait(300);
  check('double-clicking a preset loads it on the selected track', await S("const d = set.owner(P.sel).devices[0]; return d.type === 'fm' && d.preset === '808' && d.params.m1amt === 0.12 && set.owner(P.sel).devices.length === 1"));

  // saved: the notes come back after a reload
  await S('studio.stopAll(true);'); await p.keyboard.press('Tab'); await wait(900);
  await p.reload(); await p.waitForSelector('.pc-track'); await wait(1200);
  check('MIDI clips are saved', await S('return P.set.tracks[0].clips[0].notes.length === 8 && P.set.arrangement[0].clip.notes.length === 4'));

  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
