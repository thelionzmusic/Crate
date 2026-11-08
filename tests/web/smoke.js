// Smoke test: every view and sheet in Library and Perform; fails on any page error.
// Run against a running Crate:  python run_crate.py --headless --port 47800
//                               BASE=http://127.0.0.1:47800 node tests/web/smoke.js
// Needs Node with Playwright and Chromium.
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = []; p.on('pageerror', e => errs.push('PAGE ' + String(e))); p.on('console', m => m.type() === 'error' && errs.push('CONSOLE ' + m.text()));
  const shot = (n) => p.screenshot({ path: `${OUT}/${n}.png` });
  const step = async (name, fn, wait = 700) => { try { await fn(); } catch (e) { errs.push(`STEP ${name}: ${e.message}`); } await p.waitForTimeout(wait); };
  await p.goto(`${BASE}/#track=3`); await p.waitForTimeout(2500);
  console.log('isolated:', await p.evaluate(() => crossOriginIsolated));
  await shot('lib');
  const click = (sel) => p.click(sel);
  const side = (name) => p.evaluate((n) => [...document.querySelectorAll('#side .nm')].find(e => e.textContent === n).click(), name);
  await step('wave mode', async () => { await click('#w3'); await click('#wRGB'); });
  await step('play preview', async () => { await p.keyboard.press('Space'); await p.waitForTimeout(600); await p.keyboard.press('Space'); });
  await step('issues', () => side('Issues')); await shot('issues');
  await step('dupes', () => side('Duplicates'), 2500); await shot('dupes');
  await step('wish', () => side('Wishlist')); await shot('wish');
  await step('collection', () => side('Collection'));
  await step('search', async () => { await p.fill('#q', 'bpm:124-126'); }, 500);
  await step('rows', async () => { const n = await p.evaluate(() => document.querySelectorAll('#rows .r').length); if (n < 2) throw new Error('rows ' + n); });
  await step('clear', async () => { await p.fill('#q', ''); }, 500);
  await step('sort', () => click('#cols > div:nth-child(6)'));
  await step('select+arrow', async () => { await p.click('#rows .r >> nth=1'); await p.keyboard.press('ArrowDown'); });
  await step('context menu', async () => { await p.click('#rows .r >> nth=0', { button: 'right' }); await p.waitForSelector('.menu'); await p.keyboard.press('Escape'); await p.mouse.click(5, 940); });
  await step('settings', async () => { await click('#settingsBtn'); await p.waitForSelector('.sheet'); await shot('settings'); await p.keyboard.press('Escape'); }, 1200);
  await step('export', async () => { await click('#exportBtn'); await p.waitForSelector('.sheet'); await p.keyboard.press('Escape'); }, 900);
  await step('smart', async () => { await p.evaluate(() => document.querySelector('#side h3 .btn').click()); await p.click('.menu >> text=New smart playlist'); await p.waitForSelector('.rule'); await p.waitForTimeout(400); await shot('smart'); await p.keyboard.press('Escape'); }, 900);
  await step('perform', () => click('#mPerf'), 1500);
  await step('load A/B', async () => { await p.evaluate(() => { const r = [...document.querySelectorAll('#rows .r')]; return r.length; }); await p.click('#rows .r >> nth=0'); await p.keyboard.press('Shift+ArrowLeft'); await p.waitForTimeout(1200); await p.click('#rows .r >> nth=3'); await p.keyboard.press('Shift+ArrowRight'); }, 2000);
  await step('play+sync', async () => { await p.click('.pdeck[data-deck=A] .pbtn.play'); await p.click('.pdeck[data-deck=B] .pbtn >> text=SYNC'); await p.click('.pdeck[data-deck=B] .pbtn.play'); }, 2500);
  const st = await p.evaluate(async () => { const m = await import('/js/perform/index.js'); const e = m.engine, A = e.deck('A'), B = e.deck('B');
    return { A: [A.time().toFixed(2), A.bpm.toFixed(2), A.playing], B: [B.time().toFixed(2), B.bpm.toFixed(2), B.playing], phase: e.phaseError(B, A).toFixed(3), shared: A.shared, lat: e.latency }; });
  console.log('engine:', JSON.stringify(st));
  await step('hot cue C on A', () => p.click('.pdeck[data-deck=A] .hpads .pbtn >> nth=2'), 1200);
  await shot('perform');
  await step('4 decks', async () => { await click('#settingsBtn'); await p.waitForSelector('.sheet'); await p.click('.sheet .btn >> text=4 decks'); await p.keyboard.press('Escape'); }, 1500);
  await shot('perform4');
  await step('2 decks', async () => { await click('#settingsBtn'); await p.waitForSelector('.sheet'); await p.click('.sheet .btn >> text=2 decks'); await p.keyboard.press('Escape'); }, 1000);
  await step('back to library', () => click('#mLib'), 1200);
  await shot('lib2');
  await step('reload keeps library', async () => { await p.reload(); await p.waitForTimeout(2000); });
  console.log(errs.length ? errs.join('\n') : 'no errors');
  await b.close();
  process.exit(errs.length ? 1 : 0);
})();
