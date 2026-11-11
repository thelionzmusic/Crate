// CSV batches and playlist filing with the Downloads tab closed, against tests/web/mock_slskd.py.
//   BASE=http://127.0.0.1:47800 node tests/web/batch.js
const { chromium } = require('playwright');
const fs = require('fs'), os = require('os'), path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:47800';
const fails = [];
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(38)} ${detail}`); if (!ok) fails.push(name); };
const nodes = (p) => p.evaluate(async () => (await (await fetch('/api/nodes')).json()));

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE); await p.waitForTimeout(1000);

  // 1. Playlist button, then leave the tab: the track still lands in the playlist
  await p.evaluate(async () => { await fetch('/api/node/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Picks', parent_id: 0, is_folder: false }) }); const { loadNodes } = await import('/js/state.js'); await loadNodes(); });
  await p.locator('#side .item', { hasText: 'Downloads' }).click(); await p.waitForTimeout(500);
  await p.fill('.dl input.field', 'chris lake'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.dl')?.textContent.includes('best copies first'), null, { timeout: 15000 });
  await p.locator('.dl .row.group', { hasText: 'Turn Off' }).locator('button', { hasText: 'versions' }).click();
  await p.locator('.dl .vers .row', { hasText: 'crate_digger' }).locator('button', { hasText: 'Playlist' }).click();
  await p.locator('.menu [role=menuitem]', { hasText: 'Picks' }).click();
  await p.locator('#side .item', { hasText: 'Picks' }).click();  // away from Downloads, watching the playlist
  await p.waitForFunction(() => document.querySelectorAll('#rows .r').length === 1, null, { timeout: 60000, polling: 500 }).catch(() => {});
  const picks = (await nodes(p)).find((n) => n.name === 'Picks').tracks.length;
  const shown = await p.$$eval('#rows .r .ttl', (r) => r.map((x) => x.textContent));
  check(picks === 1 && shown.length === 1, 'Playlist button works with the tab closed', JSON.stringify(shown));

  // 2. a CSV: one refused-then-retried, one straight in, one that doesn't exist
  const csv = path.join(os.tmpdir(), 'Friday set.csv');
  fs.writeFileSync(csv, 'Artist,Title\nFisher,Losing It (Extended Mix)\nFisher,You Little Beauty\nNobody,Song That Does Not Exist\n');
  await p.locator('#side .item', { hasText: 'Downloads' }).click(); await p.waitForTimeout(400);
  await p.setInputFiles('input[type=file][accept^=".csv"]', csv);
  await p.waitForSelector('.sheet'); await p.waitForTimeout(200);
  const title = await p.textContent('.sheet h1');
  check(title === 'Download 3 tracks', 'CSV preview counts the tracks', title);
  await p.screenshot({ path: (process.env.S || '.') + '/batch-sheet.png' });
  await p.click('.sheet .btn.primary');
  await p.waitForFunction(() => /Batch over/.test(document.querySelector('.vers.batch')?.parentElement.textContent || ''), null, { timeout: 150000, polling: 1000 });
  const items = await p.$$eval('.vers.batch .row', (r) => r.map((x) => [x.querySelector('.ttl').textContent, x.querySelector('.dlstate').textContent, x.querySelector('.t3')?.textContent || '']));
  console.log('      ', JSON.stringify(items));
  check(items[0][1] === 'Done' && items[1][1] === 'Done', 'both real tracks downloaded');
  check(items[2][1] === 'Not found', 'missing track says not found', items[2][2]);
  const set = (await nodes(p)).find((n) => n.name === 'Friday set');
  check(set && set.tracks.length === 2, 'new playlist named after the file, filled', set ? `${set.tracks.length} tracks` : 'missing');
  await p.screenshot({ path: (process.env.S || '.') + '/batch-done.png' });
  check(errors.length === 0, 'no page errors', errors.join(' / '));
  console.log(fails.length ? `${fails.length} failed` : 'all passed'); await b.close(); process.exit(fails.length ? 1 : 0);
})();
