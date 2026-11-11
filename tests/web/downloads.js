// Downloads tab (Labs) against tests/web/mock_slskd.py: search, best copy first, download,
// import, then right-click -> Add to playlist.
//   BASE=http://127.0.0.1:47800 node tests/web/downloads.js   (Crate set to the mock's address and key)
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800';
const fails = [];
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(34)} ${detail}`); if (!ok) fails.push(name); };

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE); await p.waitForTimeout(1000);
  const side = p.locator('#side .item', { hasText: 'Downloads' });
  check(await side.count() === 1, 'Downloads tab shows with Labs on');
  await side.click(); await p.waitForTimeout(600);
  check((await p.textContent('.listhead .sub')).includes('sean_test'), 'shows the Soulseek account', await p.textContent('.listhead .sub'));
  await p.fill('.dl input.field', 'fisher'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.dl')?.textContent.includes('best copies first'), null, { timeout: 15000 });
  const rows = await p.$$eval('.dl .card:last-child .row:not(.t3)', (r) => r.map((x) => [x.querySelector('.ttl').textContent, x.querySelector('.tag').textContent]));
  console.log('      results:', JSON.stringify(rows));
  check(rows.length === 2 && rows.every(([, q]) => q.startsWith('FLAC')), 'groups tracks, lossless first', `${rows.length} tracks`);
  await p.screenshot({ path: process.env.S + '/review/dl-results.png' });

  await p.locator('.dl .row', { hasText: 'Losing It' }).locator('button', { hasText: 'Download' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent.includes('%')), null, { timeout: 10000 });
  check(true, 'shows download progress');
  await p.screenshot({ path: process.env.S + '/review/dl-progress.png' });
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'In your library'), null, { timeout: 90000, polling: 500 });
  check(true, 'imported and analysed');

  // a playlist to add it to
  const nid = await p.evaluate(async () => { const r = await fetch('/api/node/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Soulseek finds', parent_id: 0, is_folder: false }) }); return (await r.json()).id; });
  await p.evaluate(async () => { const { loadNodes } = await import('/js/state.js'); await loadNodes(); });
  await p.locator('.dl .row.lib').first().click({ button: 'right' });
  await p.locator('.menu [role=menuitem]', { hasText: 'Add to playlist' }).click();
  await p.screenshot({ path: process.env.S + '/review/dl-addto.png' });
  await p.locator('.menu [role=menuitem]', { hasText: 'Soulseek finds' }).click(); await p.waitForTimeout(500);
  const inList = await p.evaluate(async (id) => { const n = (await (await fetch('/api/nodes')).json()).find((x) => x.id === id); return n ? n.tracks.length : -1; }, nid);
  check(inList === 1, 'right-click adds it to a playlist', `${inList} track in "Soulseek finds"`);
  const t = await p.evaluate(async () => { const s = await import('/js/state.js'); return s.S.rows.find((r) => /Losing It \(Extended Mix\)\.flac$/.test(r.path)); });
  check(!!t && t.bpm > 0, 'it is a normal library track', t ? `${t.title}, ${t.bpm} BPM, ${t.camelot}` : '');
  check(errors.length === 0, 'no page errors', errors.join(' / '));
  console.log(fails.length ? `${fails.length} failed` : 'all passed'); await b.close(); process.exit(fails.length ? 1 : 0);
})();
