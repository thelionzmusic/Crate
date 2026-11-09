// Perform on the native engine, end to end: load, play, sync, effects, settings, device reopen.
// Needs a running Crate whose engine binary is built (it uses the silent test output on Linux).
//   BASE=http://127.0.0.1:47800 node tests/web/native.js
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800';
const fails = [];
const check = (ok, name, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(36)} ${detail}`); if (!ok) fails.push(name); };

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE); await p.evaluate(() => localStorage.setItem('perf', JSON.stringify({ engine: 'native', decks: 2 })));
  await p.goto(BASE); await p.waitForTimeout(800);
  await p.click('#mPerf'); await p.waitForTimeout(1500);
  const E = 'const e = (await import("/js/perform/index.js")).engine, A = e.deck("A"), B = e.deck("B");';
  const probe = () => p.evaluate(new Function(`return (async () => { ${E} return { tA: A.time(false), playing: [A.playing, B.playing], phase: A.loaded && B.loaded ? e.phaseError(B, A) : 0, peak: e.channel('A').meter.peak(), master: e.masterLevel(), st: e.backend.status(), kind: e.backend.kind, wall: performance.now() / 1000 }; })()`));

  check((await probe()).kind === 'native', 'native backend starts', (await probe()).st.name || '');
  await p.click('#rows .r >> nth=0'); await p.keyboard.press('Shift+ArrowLeft'); await p.waitForTimeout(2500);
  await p.click('#rows .r >> nth=3'); await p.keyboard.press('Shift+ArrowRight'); await p.waitForTimeout(2500);
  await p.click('.pdeck[data-deck=A] .pbtn.play'); await p.click('.pdeck[data-deck=B] .pbtn >> text=SYNC'); await p.click('.pdeck[data-deck=B] .pbtn.play');
  await p.waitForTimeout(1500); const s1 = await probe(); await p.waitForTimeout(3000); const s2 = await probe();
  const speed = (s2.tA - s1.tA) / (s2.wall - s1.wall);
  check(Math.abs(speed - 1) < 0.01, 'playhead runs in real time', `${speed.toFixed(3)} s per second`);
  check(s2.playing[0] && s2.playing[1] && Math.abs(s2.phase) < 0.03, 'sync locks B to A', `phase ${s2.phase.toFixed(3)} beats`);
  check(s2.st.load < 0.5 && s2.st.xruns === 0, 'audio thread has headroom', `${(s2.st.load * 100).toFixed(1)}% busy, ${s2.st.xruns} dropouts`);

  const smooth = await p.evaluate(new Function(`return (async () => { ${E} let back = 0, last = A.time(false);
    for (let i = 0; i < 120; i++) { await new Promise(requestAnimationFrame); const t = A.time(false); if (t < last - 1e-4) back++; last = t; } return back; })()`));
  check(smooth === 0, 'playhead never steps back', `${smooth} backward steps in 120 frames`);

  await p.click('.fxunit >> nth=0 >> .fxon'); await p.keyboard.press('l'); await p.waitForTimeout(1200); await p.keyboard.press('l');
  await p.click('.pdeck[data-deck=A] .hpads .pbtn >> nth=0'); await p.waitForTimeout(800);
  const s3 = await probe();
  check(s3.master > 0.01, 'sound reaches the master', `peak ${s3.master.toFixed(3)}`);

  await p.click('#settingsBtn'); await p.waitForSelector('.sheet'); await p.waitForTimeout(800);
  const labels = await p.evaluate(() => [...document.querySelectorAll('.sheet .gr .lbl')].map((e) => e.firstChild.textContent));
  check(['Driver', 'Output', 'Buffer size', 'Master out', 'Headphones'].every((l) => labels.includes(l)), 'settings show the native options', '');
  await p.keyboard.press('Escape');

  for (const change of [{ buffer: 512 }, { rate: 44100 }, { buffer: 256, rate: 0 }]) {
    const before = (await probe()).tA;
    await p.evaluate(async (c) => { const s = await import('/js/perform/settings.js'); await s.setPrefs(c); }, change);
    await p.waitForTimeout(1500);
    const s = await probe();
    check(s.playing[0] && s.tA > before && s.tA < before + 3, `decks survive ${JSON.stringify(change)}`, `${s.st.rate} Hz, ${s.st.buffer} samples, A at ${s.tA.toFixed(1)} s`);
  }
  check(errors.length === 0, 'no page errors', errors.join(' / '));
  console.log(fails.length ? `${fails.length} failed` : 'all passed');
  await b.close(); process.exit(fails.length ? 1 : 0);
})();
