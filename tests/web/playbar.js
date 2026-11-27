// The Library's play bar and Find better version, against tests/web/mock_slskd.py with Soulseek
// on: tracks dragged onto the bar load there; its play/pause; Normalise lifts a quiet track,
// turns off for previews or for a whole playlist (which then re-analyses and exports at its own
// level) and back on; and a 128 kbps MP3 in a playlist is replaced by a better copy from
// Soulseek, in place, the old one staying in the library.
//   BASE=http://127.0.0.1:47800 node tests/web/playbar.js <scratch dir>
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs'), path = require('path');
const BASE = process.env.BASE || 'http://127.0.0.1:47800', OUT = process.argv[2] || '.';
const fails = [];
const check = (ok, name, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(48)} ${detail}`); if (!ok) fails.push(name); };
const table = (r) => r.rows.map((row) => Object.fromEntries(r.cols.map((c, i) => [c, row[i]])));
const api = (p, url, body) => p.evaluate(async ([u, b]) => (await fetch(`/api/${u}`, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : {})).json(), [url, body]);

(async () => {
  // two tracks: Losing It as a 128 kbps MP3 (Soulseek has better), and a quiet one
  const music = path.join(OUT, 'playbar-music'); fs.rmSync(music, { recursive: true, force: true }); fs.mkdirSync(music, { recursive: true });
  const make = (file, artist, title, vol, extra) => execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=110:duration=60,volume=${vol}`, '-f', 'lavfi', '-i', 'anoisesrc=d=60:a=0.05',
    '-filter_complex', 'amix=inputs=2', '-metadata', `artist=${artist}`, '-metadata', `title=${title}`, ...extra, path.join(music, file)]);
  make('Fisher - Losing It (Extended Mix).mp3', 'Fisher', 'Losing It (Extended Mix)', 0.9, ['-b:a', '128k']);
  make('Quiet One.mp3', 'Nobody', 'Quiet One', 0.02, ['-b:a', '320k']);

  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto(BASE); await p.waitForTimeout(800);
  await api(p, 'folders', { path: music });
  const all = async () => table(await api(p, 'tracks'));
  for (let i = 0; i < 120; i++) { if ((await all()).filter((x) => x.analysed).length >= 2) break; await p.waitForTimeout(1000); }
  const tracks = await all();
  const losing = tracks.find((t) => /Losing/.test(t.title)), quiet = tracks.find((t) => /Quiet/.test(t.title));
  check(losing?.analysed && quiet?.analysed, 'both tracks analysed');
  const { id: nid } = await api(p, 'node/create', { name: 'Friday', parent_id: 0, is_folder: false });
  await api(p, 'node/tracks', { id: nid, tracks: [losing.id, quiet.id] });
  await p.reload(); await p.waitForTimeout(1000);
  await p.locator('#side .item', { hasText: 'Friday' }).click(); await p.waitForTimeout(400);

  // dragged onto the bar, it loads; the bar's own button plays and pauses it
  await p.locator('#rows .r', { hasText: 'Quiet One' }).dragTo(p.locator('#detail'));
  await p.waitForFunction(() => document.querySelector('#insp .title')?.textContent === 'Quiet One', null, { timeout: 8000 }).catch(() => {});
  check((await p.textContent('#insp .title')) === 'Quiet One', 'a track dragged onto the play bar loads');
  await p.click('#pbPlay'); await p.waitForTimeout(600);
  check(await p.evaluate(() => !document.querySelector('#audio').paused && document.querySelector('#pbPlay').classList.contains('on')), 'the bar\'s play button plays');
  await p.click('#pbPlay'); await p.waitForTimeout(200);
  check(await p.evaluate(() => document.querySelector('#audio').paused), 'and pauses');

  const gain = () => p.evaluate(async () => (await import('/js/library/preview.js')).previewGain());
  // Normalise: off by default; turned on, it lifts the quiet track
  check(!(await p.evaluate(() => document.querySelector('#norm').classList.contains('on'))) && (await gain()) === 1, 'Normalise is off by default');
  await p.click('#norm'); await p.waitForTimeout(300);
  check(await p.evaluate(() => document.querySelector('#norm').classList.contains('on')) && (await gain()) > 2, 'Normalise lifts a quiet track', `×${(await gain()).toFixed(2)}`);
  // off for the whole playlist: unnormalised, re-analysed, and back on from the bar
  await p.click('#norm'); await p.locator('.menu [role=menuitem]', { hasText: 'whole playlist' }).click(); await p.waitForTimeout(600);
  const node = async () => (await api(p, 'nodes')).find((n) => n.id === nid);
  check((await node()).normalise === 0 && (await gain()) === 1 && !(await p.evaluate(() => document.querySelector('#norm').classList.contains('on'))), 'off for the whole playlist');
  let again = false;
  for (let i = 0; i < 60 && !again; i++) { const t = (await all()).find((x) => x.id === quiet.id); again = t.analysed !== quiet.analysed; if (!again) await p.waitForTimeout(1000); }
  check(again, "the playlist's tracks are re-analysed");
  await p.locator('#side .item', { hasText: 'Friday' }).click({ button: 'right' });
  check(!(await p.locator('.menu [role=menuitem]', { hasText: 'Normalise' }).locator('use[href="#i-check"]').count()), "the playlist's menu shows Normalise off");
  await p.keyboard.press('Escape');
  await p.click('#norm'); await p.waitForTimeout(500);
  check((await node()).normalise === 1 && (await gain()) > 2, 'Normalise back on puts the playlist back too');

  // Find better version: a FLAC replaces the 128 kbps MP3 in the playlist, in its place
  await p.locator('#rows .r', { hasText: 'Losing It' }).click({ button: 'right' });
  await p.locator('.menu [role=menuitem]', { hasText: 'Find better version' }).click();
  await p.waitForFunction(() => [...document.querySelectorAll('.better .row button')].length > 0, null, { timeout: 20000 }).catch(() => {});
  const opts = await p.$$eval('.better .row', (r) => r.map((x) => x.querySelector('.tag')?.textContent).filter(Boolean));
  const head = await p.textContent('.sheet header');
  check(/You have MP3 128/.test(head) && opts.length && opts.every((q) => !/MP3 128/.test(q)), 'shows only copies better than yours', `${opts.slice(0, 3)} / ${head.slice(0, 60)}`);
  await p.screenshot({ path: `${OUT}/better.png` });
  await p.locator('.better .row button', { hasText: 'Use this' }).first().click();
  let tr = [];
  for (let i = 0; i < 90; i++) { tr = (await node()).tracks; if (tr[0] !== losing.id) break; await p.waitForTimeout(1000); }
  const rows = await all(), fresh = rows.find((t) => t.id === tr[0]);
  check(tr.length === 2 && tr[0] !== losing.id && tr[1] === quiet.id && /Losing/.test(fresh?.title || fresh?.path || ''), 'the better copy takes its place in the playlist', JSON.stringify(tr));
  check(rows.some((t) => t.id === losing.id), 'the old copy stays in the library');
  check(errors.length === 0, 'no page errors', errors.join(' / '));
  console.log(fails.length ? `${fails.length} failed` : 'all passed'); await b.close(); process.exit(fails.length ? 1 : 0);
})();
