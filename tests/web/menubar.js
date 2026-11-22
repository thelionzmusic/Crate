// The menu bar on every tab: menus open, hover and the arrows walk across them, Escape closes,
// what doesn't apply is greyed, and items do what their shortcuts do.
//   BASE=http://127.0.0.1:47800 node tests/web/menubar.js [screenshot dir]
const { chromium } = require('playwright');
const OUT = process.argv[2] || '.';
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
  const errs = []; p.on('pageerror', (e) => errs.push(String(e))); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  const check = (n, ok, i = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${n} ${i}`); if (!ok) errs.push(n); };
  await p.goto(process.env.BASE); await p.waitForSelector('#rows .r'); await p.waitForTimeout(500);
  check('menu bar on Library', (await p.locator('.mb-item').count()) === 7);
  await p.locator('.mb-item', { hasText: 'Create' }).dispatchEvent('pointerdown'); await p.waitForTimeout(150);
  await p.screenshot({ path: `${OUT}/menu-create-lib.png` });
  check('Produce items greyed in Library', (await p.locator('.menu > div.off').count()) >= 6);
  await p.locator('.mb-item', { hasText: 'View' }).hover(); await p.waitForTimeout(150);
  check('hover switches menus', (await p.locator('.menu', { hasText: 'Full screen' }).count()) === 1);
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(100);
  check('arrow walks to the next menu', (await p.locator('.menu', { hasText: 'Stop everything' }).count()) === 1);
  await p.keyboard.press('Escape'); await p.waitForTimeout(100);
  check('Escape closes', (await p.locator('.menu').count()) === 0);
  // View > Produce, then Create > MIDI track through the keyboard
  await p.keyboard.press('Alt+v'); await p.waitForTimeout(100);
  await p.locator('.menu > div', { hasText: 'Produce' }).click(); await p.waitForSelector('.pc-track'); await p.waitForTimeout(600);
  check('View > Produce', await p.evaluate(() => document.querySelector('.app').classList.contains('prod')));
  const count = () => p.evaluate(async () => (await import('/js/produce/set.js')).P.set.tracks.length);
  const before = await count();
  await p.keyboard.press('Alt+c'); await p.waitForTimeout(100);
  for (let i = 0; i < 2; i++) await p.keyboard.press('ArrowDown');
  await p.keyboard.press('Enter'); await p.waitForTimeout(300);
  check('Create > MIDI track by keyboard', (await count()) === before + 1);
  await p.locator('.mb-item', { hasText: 'Edit' }).dispatchEvent('pointerdown'); await p.waitForTimeout(100);
  await p.locator('.menu > div', { hasText: 'Undo' }).click(); await p.waitForTimeout(300);
  check('Edit > Undo', (await count()) === before);
  await p.locator('.mb-item', { hasText: 'View' }).dispatchEvent('pointerdown'); await p.waitForTimeout(100);
  await p.locator('.menu > div', { hasText: 'Timeline' }).click(); await p.waitForTimeout(300);
  check('View > Timeline', (await p.locator('.pt-head').count()) > 0);
  await p.locator('.mb-item', { hasText: 'Help' }).dispatchEvent('pointerdown'); await p.waitForTimeout(100);
  await p.screenshot({ path: `${OUT}/menu-help-prod.png` });
  await p.locator('.menu > div', { hasText: 'About Crate' }).click(); await p.waitForTimeout(300);
  check('Help > About', /Crate \d/.test(await p.locator('.toast').last().innerText().catch(() => '')));
  await p.locator('.mb-item', { hasText: 'View' }).dispatchEvent('pointerdown'); await p.waitForTimeout(100);
  await p.locator('.menu > div', { hasText: 'Perform' }).click(); await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/menu-perform.png` });
  console.log(errs.join('\n') || 'no errors'); await b.close(); process.exit(errs.length ? 1 : 0);
})();
