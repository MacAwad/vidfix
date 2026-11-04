const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DL = path.join(__dirname, 'dl') + '/';
fs.mkdirSync(DL, { recursive: true });
const EXT = process.env.VF_EXT || path.join(__dirname, '.ext-open'), BASE = 'http://localhost:8800';
const log = (...a) => console.log(...a);
let ok = 0, bad = 0;
const check = (name, cond, extra) => { if (cond) { ok++; log('  PASS', name, extra ?? ''); } else { bad++; log('  FAIL', name, extra ?? ''); } };

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(require('os').tmpdir(), 'vf-prof-' + Date.now()), {
    channel: 'chromium', headless: true, acceptDownloads: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'] });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  log('extension id', extId);
  const downloads = [];
  ctx.on('page', (pg) => pg.on('download', (d) => downloads.push(d)));
  // close the welcome tab
  await new Promise(r => setTimeout(r, 800));
  for (const pg of ctx.pages()) if (pg.url().includes('options.html')) { log('welcome page opened:', pg.url().endsWith('#welcome')); await pg.close(); }

  const page = await ctx.newPage();
  page.on('download', (d) => downloads.push(d));
  page.on('pageerror', (e) => log('PAGEERR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('CONSOLE', m.text().slice(0, 200)); });
  const vid = () => page.evaluate(() => { const v = document.getElementById('v'); return { paused: v.paused, rate: v.playbackRate, vol: v.volume, muted: v.muted, t: +v.currentTime.toFixed(2), loop: v.loop }; });

  log('\n[1] Strict (Trusted Types) page, direct file, click-eating overlay');
  await page.goto(BASE + '/p/strict-direct.html');
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(800);
  await page.mouse.move(300, 250); await page.mouse.move(320, 260);
  await page.waitForTimeout(400);
  check('bar appears on hover', await page.locator('vidfix-ui .bar.on').count() === 1);
  await page.locator('vidfix-ui button[title^="Play / pause"]').click();
  check('bar pause button works through overlay', (await vid()).paused === true);
  await page.click('#txt'); await page.keyboard.type('kjd');
  const afterType = await vid();
  check('typing in a text box does not trigger shortcuts', afterType.paused === true && afterType.rate === 1 && (await page.inputValue('#txt')) === 'kjd');
  await page.evaluate(() => document.activeElement.blur());
  await page.mouse.move(330, 270);
  await page.keyboard.press('k'); await page.waitForTimeout(150);
  check('K plays when mouse is over video', (await vid()).paused === false);
  await page.keyboard.press('Shift+D'); await page.keyboard.press('d'); await page.keyboard.press('d');
  check('D speeds up (Shift/Caps safe)', Math.abs((await vid()).rate - 1.3) < 0.001, (await vid()).rate);
  await page.keyboard.press('s');
  check('S slows down', Math.abs((await vid()).rate - 1.2) < 0.001);
  await page.keyboard.press('m');
  check('M unmutes', (await vid()).muted === false);
  for (let i = 0; i < 15; i++) await page.keyboard.press('Equal');
  const pctTxt = await page.locator('vidfix-ui .pct').textContent();
  check('volume boost past 100% (same-origin file)', pctTxt === '250%', pctTxt);
  for (let i = 0; i < 15; i++) await page.keyboard.press('Minus');
  check('volume back down', (await page.locator('vidfix-ui .pct').textContent()) === '100%');
  const t0 = (await vid()).t; await page.keyboard.press('l'); const t1 = (await vid()).t;
  check('L jumps forward 5s', t1 - t0 > 4.5, `${t0} -> ${t1}`);
  await page.keyboard.press('o'); check('O toggles loop', (await vid()).loop === true);
  await page.keyboard.press('o');
  // speed menu
  await page.locator('vidfix-ui .bar button[title^="Speed"]').click();
  await page.locator('vidfix-ui .menu button', { hasText: '2x' }).first().click();
  check('speed menu sets 2x', (await vid()).rate === 2);

  log('\n[2] Download direct file');
  await page.locator('vidfix-ui button[title^="Download"]').click();
  await page.waitForTimeout(1200);
  const opts = await page.locator('vidfix-ui .menu .opt .l').allTextContents();
  log('  options:', opts);
  check('direct file option first', opts[0] === 'Video file');
  const nBefore = downloads.length;
  await page.locator('vidfix-ui .menu .opt button').first().click();
  await page.waitForTimeout(2500);
  const st = await page.locator('vidfix-ui .menu .status').textContent();
  const items = await sw.evaluate(() => new Promise(r => chrome.downloads.search({}, r)));
  log('  status:', st);
  check('direct file handed to Chrome downloads', items.some(i => /progressive\.mp4$/.test(i.url) && i.filename), items.map(i => i.filename + ' ' + i.state).join(' | '));

  log('\n[3] Screenshot (G)');
  await page.mouse.move(340, 280);
  const dlP = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await page.keyboard.press('g');
  const shot = await dlP;
  if (shot) { const f = DL + shot.suggestedFilename(); await shot.saveAs(f); check('screenshot saved as PNG', f.endsWith('.png') && fs.statSync(f).size > 5000, shot.suggestedFilename()); }
  else check('screenshot saved', false);

  log('\n[4] Per-site memory after reload');
  await page.reload(); await page.evaluate(() => document.getElementById('v').play()); await page.waitForTimeout(700);
  check('speed remembered for this site (2x)', (await vid()).rate === 2, (await vid()).rate);

  log('\n[5] Recording (from here, 3 s)');
  await page.mouse.move(300, 250); await page.mouse.move(310, 255); await page.waitForTimeout(300);
  await page.locator('vidfix-ui button[title="More"]').click();
  await page.locator('vidfix-ui .menu button', { hasText: 'Record video' }).click();
  await page.waitForTimeout(300);
  await page.locator('vidfix-ui .menu .opt', { hasText: 'Record from here' }).locator('button').click();
  await page.waitForTimeout(3200);
  const recP = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await page.mouse.move(300, 250); await page.mouse.move(305, 252); await page.waitForTimeout(200);
  await page.locator('vidfix-ui button[title="More"]').click();
  await page.locator('vidfix-ui .menu button', { hasText: 'Stop recording' }).click();
  const recD = await recP;
  if (recD) { const f = DL + recD.suggestedFilename(); await recD.saveAs(f); check('recording saved', fs.statSync(f).size > 20000, recD.suggestedFilename() + ' ' + fs.statSync(f).size); }
  else check('recording saved', false);

  log(`\nRESULT ${ok} passed, ${bad} failed`);
  await ctx.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
