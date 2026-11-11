// Downloads tab (Labs) against tests/web/mock_slskd.py (Crate set to "My own slskd"): search,
// versions, a refused download with its reason and a retry, the Playlist button, right-click.
//   BASE=http://127.0.0.1:47800 node tests/web/downloads.js
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47800';
const fails = [];
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(36)} ${detail}`); if (!ok) fails.push(name); };
const nodes = (p) => p.evaluate(async () => (await (await fetch('/api/nodes')).json()));

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE); await p.waitForTimeout(1000);
  // a playlist to file things into
  await p.evaluate(async () => { await fetch('/api/node/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Soulseek finds', parent_id: 0, is_folder: false }) }); const { loadNodes } = await import('/js/state.js'); await loadNodes(); });
  const nid = (await nodes(p)).find((n) => n.name === 'Soulseek finds').id;

  await p.locator('#side .item', { hasText: 'Downloads' }).click(); await p.waitForTimeout(600);
  check((await p.textContent('.listhead .sub')).includes('sean_test'), 'shows the Soulseek account');
  await p.fill('.dl input.field', 'fisher'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => document.querySelector('.dl')?.textContent.includes('best copies first'), null, { timeout: 15000 });
  const groups = await p.$$eval('.dl .row.group', (r) => r.map((x) => [x.querySelector('.ttl').textContent, x.querySelector('.tag').textContent]));
  check(groups.length === 2 && groups.every(([, q]) => q.startsWith('FLAC')), 'groups tracks, lossless first', JSON.stringify(groups));

  // versions: an inline list that scrolls
  const losing = p.locator('.dl .row.group', { hasText: 'Losing It' });
  await losing.locator('button', { hasText: 'versions' }).click(); await p.waitForTimeout(200);
  const vers = await p.$eval('.dl .vers', (v) => ({ rows: v.querySelectorAll('.row').length, scrolls: v.scrollHeight > v.clientHeight + 4, overflow: getComputedStyle(v).overflowY }));
  check(vers.rows >= 10 && vers.scrolls && vers.overflow === 'auto', 'versions list scrolls', `${vers.rows} versions`);
  await p.locator('.dl .row.group', { hasText: 'Little Beauty' }).locator('button', { hasText: 'versions' }).click(); await p.waitForTimeout(200);
  const pane = await p.$eval('.dl', (el) => { const before = el.scrollTop; el.scrollTop = 99999; const moved = el.scrollTop > before; el.scrollTop = 0;
    return { moved, inside: el.getBoundingClientRect().bottom <= el.parentElement.getBoundingClientRect().bottom + 1 }; });
  check(pane.moved && pane.inside, 'results area scrolls inside the panel');
  await p.locator('.dl .row.group', { hasText: 'Little Beauty' }).locator('button', { hasText: 'versions' }).click(); await p.waitForTimeout(200);
  await p.screenshot({ path: (process.env.S || '.') + '/dl-versions.png' });

  // the best copy is refused: say so, say why, offer the next version
  await losing.locator('button', { hasText: 'Download' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'Download failed'), null, { timeout: 15000 });
  const why = await p.locator('.dl .why').first().textContent();
  check(/doesn't have that file/.test(why), 'failed download says why', why);
  const stuck = await p.$$eval('.dl .vers button', (bs) => bs.filter((b) => b.textContent === 'Queued').length);
  check(stuck === 0, 'other versions stay downloadable', `${stuck} marked queued`);
  await p.screenshot({ path: (process.env.S || '.') + '/dl-failed.png' });
  await p.locator('.dl button', { hasText: 'Try another version' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'In your library'), null, { timeout: 90000, polling: 500 });
  check(true, 'retry with the next version works');

  // Playlist button: downloads, analyses, then files it
  await losing.locator('button', { hasText: 'versions' }).click();  // close one list, open the other
  await p.locator('.dl .row.group', { hasText: 'Little Beauty' }).locator('button', { hasText: 'versions' }).click();
  await p.locator('.dl .vers .row', { hasText: 'crate_digger' }).locator('button', { hasText: 'Playlist' }).click();
  await p.locator('.menu [role=menuitem]', { hasText: 'Soulseek finds' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'In Soulseek finds'), null, { timeout: 90000, polling: 500 });
  const inList = (await nodes(p)).find((n) => n.id === nid).tracks;
  const t = await p.evaluate(async (ids) => { const s = await import('/js/state.js'); await s.loadTracks(); return ids.map((id) => s.S.byId.get(id)).filter(Boolean).map((x) => [x.title, x.bpm, x.camelot]); }, inList);
  check(inList.length === 1 && t[0] && t[0][1] > 0, 'Playlist button: analysed, then in it', JSON.stringify(t));

  // right-click on a finished download still works
  await p.locator('.dl .row.lib', { hasText: 'Losing It' }).first().click({ button: 'right' });
  await p.locator('.menu [role=menuitem]', { hasText: 'Add to playlist' }).click();
  await p.locator('.menu [role=menuitem]', { hasText: 'Soulseek finds' }).click(); await p.waitForTimeout(500);
  check((await nodes(p)).find((n) => n.id === nid).tracks.length === 2, 'right-click adds to a playlist');
  await p.screenshot({ path: (process.env.S || '.') + '/dl-done.png' });
  check(errors.length === 0, 'no page errors', errors.join(' / '));
  console.log(fails.length ? `${fails.length} failed` : 'all passed'); await b.close(); process.exit(fails.length ? 1 : 0);
})();
