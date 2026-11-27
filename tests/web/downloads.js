// Downloads tab (Labs) against tests/web/mock_slskd.py (Crate set to "My own slskd"): search,
// versions, a refused FLAC falling back to an MP3 by itself, the Playlist button, right-click.
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
  // typing survives the poll loop's redraws (it used to wipe the box every few seconds)
  await p.click('.dl input.field'); await p.keyboard.type('fish', { delay: 120 }); await p.waitForTimeout(6000); await p.keyboard.type('er');
  const typed = await p.evaluate(() => ({ v: document.querySelector('.dl input.field').value, focus: document.activeElement === document.querySelector('.dl input.field') }));
  check(typed.v === 'fisher' && typed.focus, 'typing survives redraws', JSON.stringify(typed));
  await p.keyboard.press('Enter');
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
  // scrolled down after clicking something, it stays there through the poll's redraws (the
  // search box used to take focus back on every poll and scroll the list up to itself)
  await p.setViewportSize({ width: 1600, height: 640 }); await p.waitForTimeout(200);
  await p.locator('.dl .row.group', { hasText: 'Losing It' }).locator('button', { hasText: 'versions' }).click();
  await p.locator('.dl .row.group', { hasText: 'Losing It' }).locator('button', { hasText: 'versions' }).click(); await p.waitForTimeout(200);
  const set = await p.evaluate(() => { const el = document.querySelector('.dl'), v = el.querySelector('.vers');
    el.scrollTop = el.scrollHeight; v.scrollTop = 120; return [el.scrollTop, v.scrollTop]; });
  // what happens while downloads import: the library refreshes (and nothing has focus)
  await p.evaluate(async () => { document.activeElement?.blur(); const { emit } = await import('/js/core/bus.js'); emit('tracks'); emit('nodes'); });
  await p.waitForTimeout(6500);
  const held = await p.evaluate(() => [document.querySelector('.dl').scrollTop, document.querySelector('.dl .vers').scrollTop]);
  check(set[0] > 100 && Math.abs(held[0] - set[0]) < 2 && Math.abs(held[1] - set[1]) < 2, 'scroll stays put through redraws', `${JSON.stringify(set)} → ${JSON.stringify(held)}`);
  await p.setViewportSize({ width: 1600, height: 950 });
  await p.$eval('.dl', (el) => { el.scrollTop = 0; });
  await p.locator('.dl .row.group', { hasText: 'Little Beauty' }).locator('button', { hasText: 'versions' }).click(); await p.waitForTimeout(200);
  await p.screenshot({ path: (process.env.S || '.') + '/dl-versions.png' });

  // the best copy (a FLAC) is refused: Crate says why and goes on to an MP3 by itself
  await losing.locator('button', { hasText: 'Download' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'Trying another copy'), null, { timeout: 15000 });
  const why = await p.locator('.dl .card .row', { hasText: 'Trying another copy' }).first().textContent();
  check(/FLAC.*failed \(The sharer doesn't have that file any more\), trying MP3/.test(why), 'a refused FLAC falls back to an MP3, saying why', why);
  const stuck = await p.$$eval('.dl .vers button', (bs) => bs.filter((b) => b.textContent === 'Queued').length);
  check(stuck <= 1, 'other versions stay downloadable', `${stuck} marked queued`);
  await p.screenshot({ path: (process.env.S || '.') + '/dl-failed.png' });
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'In your library'), null, { timeout: 90000, polling: 500 });
  const rows = await p.$$eval('.dl .card .row', (r) => r.filter((x) => /Losing It/.test(x.textContent) && x.querySelector('.dlstate')).map((x) => x.querySelector('.dlstate').textContent));
  check(rows.length === 1 && rows[0] === 'In your library', 'the MP3 arrives, and the failed FLAC drops away', JSON.stringify(rows));

  // a download with nothing to fall back on fails plainly, with Retry MP3; pressed, an MP3 comes in
  const vv = await p.evaluate(async () => {
    const post = (u, b) => fetch(`/api/${u}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json());
    const { id } = await post('slsk/search', { q: 'you little beauty' });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 700));
      const { groups } = await (await fetch(`/api/slsk-results/${id}`)).json();
      const src = groups.flatMap((g) => g.sources).find((x) => x.user === 'vinylvault');
      if (src) return src;
    }
    return null;
  });
  await p.evaluate(async (src) => fetch('/api/slsk/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: src.user, filename: src.filename, size: src.size }) }), vv);
  const failedRow = p.locator('.dl .card .row', { hasText: 'Download failed' }).filter({ hasText: 'Little Beauty' });
  await failedRow.first().waitFor({ timeout: 20000 });
  check(await failedRow.first().locator('button', { hasText: 'Retry MP3' }).count() === 1, 'a failed download offers Retry MP3');
  await failedRow.first().locator('button', { hasText: 'Retry MP3' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .card .row')].some((r) => /Little Beauty/.test(r.textContent) && /\.mp3/i.test(r.textContent) && r.querySelector('.dlstate')?.textContent === 'In your library'), null, { timeout: 90000, polling: 500 }).catch(() => {});
  const mp3in = await p.$$eval('.dl .card .row', (r) => r.some((x) => /Little Beauty/.test(x.textContent) && x.querySelector('.dlstate')?.textContent === 'In your library'));
  check(mp3in, 'Retry MP3 brings in an MP3');

  // Playlist button: downloads, analyses, then files it
  await p.fill('.dl input.field', 'turn off the lights'); await p.keyboard.press('Enter');  // one not downloaded yet
  await p.waitForFunction(() => /tracks for "turn off the lights", best copies first/.test(document.querySelector('.dl')?.textContent || ''), null, { timeout: 15000 });
  await p.locator('.dl .row.group', { hasText: 'Turn Off' }).locator('button', { hasText: 'versions' }).click();
  await p.locator('.dl .vers .row', { hasText: 'crate_digger' }).locator('button', { hasText: 'Playlist' }).click();
  await p.locator('.menu [role=menuitem]', { hasText: 'Soulseek finds' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.dl .dlstate')].some((e) => e.textContent === 'In Soulseek finds'), null, { timeout: 90000, polling: 500 });
  const inList = (await nodes(p)).find((n) => n.id === nid).tracks;
  const t = await p.evaluate(async (ids) => { const s = await import('/js/state.js'); await s.loadTracks(); return ids.map((id) => s.S.byId.get(id)).filter(Boolean).map((x) => [x.title, x.bpm, x.camelot]); }, inList);
  check(inList.length === 1 && t[0] && /Turn Off/.test(t[0][0]) && t[0][1] > 0, 'Playlist button: analysed, then in it', JSON.stringify(t));

  // right-click on a finished download still works
  await p.locator('.dl .row.lib', { hasText: 'Losing It' }).first().click({ button: 'right' });
  await p.locator('.menu [role=menuitem]', { hasText: 'Add to playlist' }).click();
  await p.locator('.menu [role=menuitem]', { hasText: 'Soulseek finds' }).click(); await p.waitForTimeout(500);
  check((await nodes(p)).find((n) => n.id === nid).tracks.length === 2, 'right-click adds to a playlist');
  await p.screenshot({ path: (process.env.S || '.') + '/dl-done.png' });
  // Clear list: the finished and failed ones go; what came in is still known about
  const before = await p.$$eval('.dl .card .row .dlstate', (r) => r.length);
  await p.locator('.dl button', { hasText: 'Clear list' }).click(); await p.waitForTimeout(2500);
  const after = await p.$$eval('.dl .card .row .dlstate', (r) => r.length);
  const left = await p.evaluate(async () => (await (await fetch('/api/slsk-downloads')).json()));
  check(before > 0 && after === 0 && (left.transfers || left).length === 0, 'Clear list empties the list', `${before} → ${after}`);

  // a search for something already downloaded says so, with nothing to download it again (cleared or not)
  await p.fill('.dl input.field', 'losing it'); await p.keyboard.press('Enter');
  await p.waitForFunction(() => /best copies first/.test(document.querySelector('.dl')?.textContent || ''), null, { timeout: 15000 });
  const lr = p.locator('.dl .row.group', { hasText: 'Losing It' });
  check(/Downloaded already/.test(await lr.textContent()) && (await lr.locator('button', { hasText: /^Download$/ }).count()) === 0, 'a song downloaded before says Downloaded already');
  const r2 = await p.evaluate(async () => (await fetch('/api/slsk/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: 'crate_digger', filename: '@@music\\Fisher\\Fisher - Losing It (Extended Mix).flac', size: 48000000 }) })).json());
  check(r2.already === true, 'and downloading it anyway is refused', JSON.stringify(r2));
  check(errors.length === 0, 'no page errors', errors.join(' / '));
  console.log(fails.length ? `${fails.length} failed` : 'all passed'); await b.close(); process.exit(fails.length ? 1 : 0);
})();
