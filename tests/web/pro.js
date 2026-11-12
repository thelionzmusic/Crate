// The new screens: Crate Pro in Settings, Live (with a simulated CDJ), What next, Import
// from rekordbox, Check stick, backups and problem reports. Fails on any page error.
//   BASE=http://127.0.0.1:47811 STICK=/path/to/export SHOTS=dir node tests/web/pro.js
const { chromium } = require('playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:47811', SHOTS = process.env.SHOTS || '.';
const fails = [];
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(40)} ${detail}`); if (!ok) fails.push(name); };
const post = (p, url, body) => p.evaluate(async ([u, b]) => (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json(), [url, body]);

(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE); await p.waitForTimeout(300);
  await post(p, '/api/settings', { prolink: 0 }); await p.reload(); await p.waitForTimeout(1200);  // the toggle below turns it on

  // Settings: Crate Pro (owner), CDJs, backups, report
  await p.locator('#settingsBtn, [data-help*="Settings"], button:has(svg use[href="#i-gear"])').first().click();
  await p.waitForSelector('.sheet .glabel:has-text("Crate Pro")');
  const sheetText = await p.locator('.sheet').innerText();
  check(sheetText.includes('Crate Pro: Owner'), 'Settings shows the owner licence');
  check(sheetText.includes('Invite a tester') && sheetText.includes('GitHub access token'), 'Owner sees invite and token setup');
  check(sheetText.includes('Follow the CDJs'), 'CDJs toggle is there');
  await p.waitForTimeout(500);
  const backups = await p.locator('.sheet select').filter({ hasText: /,|None yet|today|Nov/ }).first().innerText().catch(() => '');
  check(backups.length > 0, 'Backups list loads', backups.split('\n')[0]);
  check(sheetText.includes('Report a problem'), 'Report a problem row');
  await p.locator('.sheet .glabel:has-text("Crate Pro")').scrollIntoViewIfNeeded();
  await p.screenshot({ path: `${SHOTS}/pro-settings.png` });
  await p.locator('.gr:has-text("Follow the CDJs") input[type=checkbox], .gr:has-text("Follow the CDJs") .sw').first().click();
  await p.waitForTimeout(600);
  await p.keyboard.press('Escape');

  // Live, fed by the simulated CDJ (tests/web/sim_cdj.py)
  await p.waitForSelector('#side .item:has-text("Live")', { timeout: 5000 }).catch(() => {});
  await p.locator('#side .item', { hasText: 'Live' }).click();
  await p.waitForFunction(() => document.querySelector('.deck-live'), null, { timeout: 15000 }).catch(() => {});
  const live = await p.locator('.pane').innerText().catch(() => '');
  check(/Deck 1/.test(live) && /On air/.test(live), 'Live shows the playing deck', live.split('\n').slice(0, 3).join(' | '));
  await p.waitForFunction(() => document.querySelector('.pane')?.innerText.includes('Up next after'), null, { timeout: 8000 }).catch(() => {});
  check((await p.locator('.pane').innerText()).includes('Up next after'), 'Live suggests what to play next');
  await p.waitForFunction(() => document.querySelectorAll('.setline').length > 0, null, { timeout: 45000 }).catch(() => {});
  check(await p.locator('.setline').count() > 0, 'Set log fills in after 30 s on air');
  await p.screenshot({ path: `${SHOTS}/pro-live.png` });

  // What next from the track menu
  await p.locator('#side .item', { hasText: 'Collection' }).click(); await p.waitForTimeout(500);
  await p.locator('#rows .r').first().click({ button: 'right' });
  await p.locator('.menu [role=menuitem]', { hasText: 'What next?' }).click();
  await p.waitForSelector('.sheet .nextrow', { timeout: 5000 }).catch(() => {});
  const nexts = await p.locator('.sheet .nextrow').count();
  const tags = await p.locator('.sheet .nextrow .tag').allInnerTexts();
  check(nexts > 0, 'What next lists tracks', `${nexts} rows`);
  check(tags.some((t) => t.includes('played today')), 'and flags one played today', JSON.stringify(tags));
  await p.screenshot({ path: `${SHOTS}/pro-next.png` });
  await p.keyboard.press('Escape');

  // Import from rekordbox chooser
  await p.evaluate(async () => { const m = await import('/js/sheets/music.js'); m.importRekordbox(); });
  await p.waitForSelector('.sheet:has-text("Import from rekordbox")');
  check((await p.locator('.sheet').innerText()).includes('rekordbox.xml'), 'Import chooser offers stick and XML');
  await p.screenshot({ path: `${SHOTS}/pro-import.png` });
  await p.keyboard.press('Escape');

  // Check stick, through the job and its result sheet
  if (process.env.STICK) {
    await post(p, '/api/stick/check', { path: process.env.STICK });
    await p.evaluate(async () => (await import('/js/jobs.js')).pollSoon());
    await p.waitForSelector('.sheet:has-text("Stick")', { timeout: 20000 }).catch(() => {});
    check((await p.locator('.sheet').innerText().catch(() => '')).match(/Stick (looks good|needs attention)/), 'Check stick shows its findings');
    await p.screenshot({ path: `${SHOTS}/pro-check.png` });
    await p.keyboard.press('Escape');
  }
  // Report sheet
  await p.evaluate(async () => { (await import('/js/sheets/report.js')).reportProblem(); });
  await p.waitForSelector('.sheet:has-text("Report a problem")');
  check(true, 'Report sheet opens');
  await p.keyboard.press('Escape');

  check(!errors.length, 'No page errors', errors.slice(0, 3).join(' | '));
  await b.close();
  console.log(fails.length ? `${fails.length} FAILED` : 'all ok');
  process.exit(fails.length ? 1 : 0);
})();
