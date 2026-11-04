const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const DL = path.join(__dirname, 'dl') + '/';
fs.mkdirSync(DL, { recursive: true });
const { execSync } = require('child_process');
const EXT = process.env.VF_EXT || path.join(__dirname, '.ext-open'), BASE = 'http://localhost:8800';
const log = (...a) => console.log(...a);
let ok = 0, bad = 0;
const check = (name, cond, extra) => { if (cond) { ok++; log('  PASS', name, extra ?? ''); } else { bad++; log('  FAIL', name, extra ?? ''); } };
const probe = (f) => { try { return execSync(`ffprobe -v error -count_frames -show_entries stream=codec_type,codec_name,nb_read_frames -show_entries format=duration -of compact "${f}"`).toString().trim().replace(/\n/g, ' | '); } catch (e) { return 'PROBE ERROR ' + e.message; } };

(async () => {
  const ctx = await chromium.launchPersistentContext(path.join(require('os').tmpdir(), 'vf-prof2-' + Date.now()), {
    channel: 'chromium', headless: true, acceptDownloads: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required'] });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  const extId = sw.url().split('/')[2];
  await new Promise(r => setTimeout(r, 600));
  for (const pg of ctx.pages()) if (pg.url().includes('options.html')) await pg.close();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('PAGEERR', e.message));

  async function saveFlow(label, pick) {
    await page.mouse.move(200, 300); await page.mouse.move(210, 310); await page.waitForTimeout(400);
    await page.locator('vidfix-ui button[title^="Download"]').click();
    await page.waitForTimeout(2500);
    const labels = await page.locator('vidfix-ui .menu .opt .l').allTextContents();
    const details = await page.locator('vidfix-ui .menu .opt .d').allTextContents();
    log('  options:', labels.map((l, i) => l + ' [' + details[i] + ']').join(' ; '));
    const row = page.locator('vidfix-ui .menu .opt', { hasText: pick }).first();
    if (!(await row.count())) { check(label + ': option "' + pick + '" offered', false); return null; }
    check(label + ': option "' + pick + '" offered', true);
    const dP = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await row.locator('button').click();
    const d = await dP;
    if (!d) { check(label + ': file saved', false, await page.locator('vidfix-ui .menu .status').textContent()); return null; }
    const f = DL + d.suggestedFilename();
    await d.saveAs(f);
    const pr = probe(f);
    log('  file:', d.suggestedFilename(), '=>', pr);
    return pr;
  }

  log('\n[6] Facebook-style split video + audio (MSE, blob: src)');
  await page.goto(BASE + '/p/dash.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 10000 });
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(500);
  const pr6 = await saveFlow('fb', 'Best quality (360p)');
  check('fb: one file with video AND sound, full length', pr6 && /h264/.test(pr6) && /aac/.test(pr6) && /nb_read_frames=600/.test(pr6));

  log('\n[7] X-style HLS (fMP4, separate audio rendition)');
  await page.goto(BASE + '/p/hls.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 10000 });
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(1500);
  const pr7 = await saveFlow('hls', 'Best quality (360p)');
  check('hls: one file with video AND sound, full length', pr7 && /h264/.test(pr7) && /aac/.test(pr7) && /nb_read_frames=600/.test(pr7));

  log('\n[8] HLS with TS segments');
  await page.goto(BASE + '/p/hlsts.html');
  await page.waitForFunction(() => window.ready, null, { timeout: 10000 });
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(1500);
  const pr8 = await saveFlow('ts', 'Full video');
  check('ts: full stream saved', pr8 && /h264/.test(pr8) && /aac/.test(pr8) && /nb_read_frames=600/.test(pr8));

  log('\n[9] Shadow DOM player (Reddit-style) and iframe embed');
  await page.goto(BASE + '/p/shadow.html');
  await page.evaluate(() => document.getElementById('sp').shadowRoot.querySelector('video').play());
  await page.waitForTimeout(500);
  await page.mouse.move(300, 200); await page.mouse.move(310, 210); await page.waitForTimeout(500);
  check('bar appears over shadow-DOM video', await page.locator('vidfix-ui .bar.on').count() === 1);
  await page.locator('vidfix-ui button[title^="Play / pause"]').click();
  check('shadow video paused by bar', await page.evaluate(() => document.getElementById('sp').shadowRoot.querySelector('video').paused));
  const frame = page.frames().find((f) => f.url().includes('strict-direct'));
  await frame.evaluate(() => document.getElementById('v').play());
  const ib = await page.locator('iframe').boundingBox();
  await page.mouse.move(ib.x + 200, ib.y + 250); await page.mouse.move(ib.x + 210, ib.y + 260); await page.waitForTimeout(500);
  check('bar appears inside cross-page iframe', await frame.locator('vidfix-ui .bar.on').count() === 1);

  log('\n[10] Site that resets speed on pause / seek');
  await page.goto(BASE + '/p/reset.html');
  await page.evaluate(() => document.getElementById('v').play());
  await page.mouse.move(300, 200); await page.mouse.move(305, 205); await page.waitForTimeout(300);
  for (let i = 0; i < 5; i++) await page.keyboard.press('d');
  await page.keyboard.press('k'); await page.waitForTimeout(150);
  await page.keyboard.press('l'); await page.waitForTimeout(400);
  const r10 = await page.evaluate(() => document.getElementById('v').playbackRate);
  check('speed kept at 1.5x after site reset it', Math.abs(r10 - 1.5) < 0.001, r10);

  log('\n[11] Page with no video (performance)');
  await page.goto(BASE + '/p/novideo.html');
  await page.waitForTimeout(300);
  const t = Date.now();
  for (let i = 0; i < 300; i++) await page.mouse.move(100 + (i % 50) * 5, 100 + (i % 30) * 5);
  log('  300 mouse moves took', Date.now() - t, 'ms');
  check('no UI injected on pages without video', await page.locator('vidfix-ui').count() === 0);
  await page.click('#t'); await page.keyboard.type('kdsjl');
  check('keys type normally', (await page.inputValue('#t')) === 'kdsjl');

  log('\n[12] YouTube: downloads blocked, bar off by default');
  await ctx.route('https://www.youtube.com/**', (route) => route.request().url().endsWith('.mp4')
    ? route.fulfill({ contentType: 'video/mp4', body: fs.readFileSync(path.join(__dirname, 'media', 'progressive.mp4')) })
    : route.fulfill({ contentType: 'text/html',
    body: '<html><head><title>YouTube</title></head><body><video id="v" src="/v.mp4" muted style="width:640px;height:360px"></video></body></html>' }));
  await page.goto('https://www.youtube.com/watch?v=test');
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(500);
  await page.mouse.move(300, 200); await page.mouse.move(305, 205); await page.waitForTimeout(500);
  check('no VidFix bar on YouTube', await page.locator('vidfix-ui .bar.on').count() === 0);
  const ytTab = await sw.evaluate(() => new Promise(r => chrome.tabs.query({ url: 'https://www.youtube.com/*' }, (t) => r(t[0].id))));
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/pages/popup.html?tab=${ytTab}`);
  await pop.waitForTimeout(800);
  const popText = await pop.locator('body').innerText();
  check('popup lists the video with speed + volume', /Video 1/.test(popText) && /Speed/.test(popText));
  check('popup save button disabled on YouTube', await pop.locator('button.btn.primary').isDisabled());
  await pop.locator('.chip', { hasText: '1.5x' }).click();
  await page.waitForTimeout(200);
  check('popup speed works on YouTube', (await page.evaluate(() => document.getElementById('v').playbackRate)) === 1.5);
  await pop.screenshot({ path: DL + 'popup_yt.png' });
  await pop.close();

  log('\n[13] Popup on a normal site + per-site off switch');
  await page.goto(BASE + '/p/strict-direct.html');
  await page.evaluate(() => document.getElementById('v').play());
  await page.waitForTimeout(400);
  const tabId = await sw.evaluate(() => new Promise(r => chrome.tabs.query({ url: 'http://localhost:8800/*' }, (t) => r(t[0].id))));
  const pop2 = await ctx.newPage();
  await pop2.goto(`chrome-extension://${extId}/pages/popup.html?tab=${tabId}`);
  await pop2.waitForTimeout(800);
  await pop2.screenshot({ path: DL + 'popup.png' });
  await pop2.locator('.switch').click();
  await pop2.waitForTimeout(500);
  await page.bringToFront();
  await page.mouse.move(300, 250); await page.mouse.move(310, 260); await page.waitForTimeout(500);
  check('turning the site off removes the bar', await page.locator('vidfix-ui').count() === 0);
  await pop2.locator('.switch').click();
  await pop2.close();

  log(`\nRESULT ${ok} passed, ${bad} failed`);
  await ctx.close();
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
