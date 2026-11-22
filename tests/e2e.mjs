// End-to-end: serve docs/ statically, play every mode start-to-finish in headless Chrome at
// desktop 1280x800 and phone 390x844 (touch), plus quick landscape sanity checks.
// Collects console errors + page errors (must be 0) and saves screenshots.
//
//   node tests/e2e.mjs            (needs playwright; see PLAYWRIGHT env var below)
//
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { spawn } from 'node:child_process';

const PW = process.env.PLAYWRIGHT || '/home/box/swarm/side-gig/games/triangulate/node_modules/playwright/index.mjs';
const { chromium } = await import(PW);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOTS = process.env.SHOTS_DIR || '/workspace/arcade-shots/orbithop';
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ' — ' + detail : ''}`);
};

async function freePort(lo = 8842, hi = 8849) {
  for (let p = lo; p <= hi; p++) {
    const ok = await new Promise((res) => {
      const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('no free port in range');
}

async function serve() {
  const port = await freePort();
  const py = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '-d', path.join(ROOT, 'docs')], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise((r) => http.get(`http://127.0.0.1:${port}/index.html`, (res) => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
    if (ok) return { port, close: () => py.kill() };
    await new Promise((r) => setTimeout(r, 100));
  }
  py.kill();
  throw new Error('server did not start');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = (page) => page.evaluate(() => window.__orbithop.state);

async function waitFor(page, fn, { timeout = 90000, poll = 150, label = 'condition' } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await state(page);
    if (fn(st)) return st;
    await sleep(poll);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(await state(page))}`);
}

const RESULT_BTNS = new Set(['#btn-retry', '#btn-menu', '#btn-share']);
async function press(page, mobile, selector, { guard = true } = {}) {
  // results buttons ignore input for ~0.55 s after the card appears (ghost-tap guard)
  if (guard && RESULT_BTNS.has(selector)) await sleep(650);
  if (mobile) {
    const box = await page.locator(selector).boundingBox();
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await page.click(selector);
  }
}

/** A real player input: touch tap on the canvas (phone) or Space (desktop). */
async function playerTap(page, mobile) {
  if (mobile) await page.touchscreen.tap(195, 600);
  else await page.keyboard.press('Space');
}

async function checkLayout(page, label) {
  // nothing may overflow the viewport horizontally; tap targets >= 40px
  const info = await page.evaluate(() => {
    const vw = innerWidth;
    const bad = [];
    for (const el of document.querySelectorAll('button, a')) {
      if (el.closest('[hidden]') || !el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > vw + 1 || r.left < -1) bad.push(`overflow:${el.id || el.className}`);
      if (r.height < 40 && !el.classList.contains('link-btn')) bad.push(`small:${el.id || el.className}:${Math.round(r.height)}`);
    }
    return { bad, scrollW: document.documentElement.scrollWidth, vw };
  });
  check(`${label}: no overflow / tap targets ok`, info.bad.length === 0 && info.scrollW <= info.vw, info.bad.join(', '));
}

async function runViewport(browser, base, vp) {
  const { name, mobile } = vp;
  console.log(`\n▶ ${name} (${vp.options.viewport.width}x${vp.options.viewport.height})`);
  const ctx = await browser.newContext({ ...vp.options, permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route(/gc\.zgo\.at|goatcounter\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' })); // analytics stubbed in tests
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${name}-${n}.png`) });

  await page.goto(base + '/');
  await page.waitForFunction(() => !!window.__orbithop);
  await sleep(1200);
  await shot('01-title');
  check(`${name}: title visible`, await page.isVisible('#screen-title'));
  check(`${name}: bots labelled on title`, /bots/i.test(await page.textContent('.mode-race')));
  check(`${name}: More games link`, (await page.getAttribute('.more-link', 'href')) === '../arcade/');
  await checkLayout(page, `${name} title`);

  // ---------------------------------------------------------------- Endless
  await press(page, mobile, '.mode-endless');
  await page.waitForSelector('#screen-howto:not([hidden])');
  await sleep(450);
  await shot('02-howto');
  check(`${name}: how-to shown on first play`, true);
  await checkLayout(page, `${name} how-to`);
  await press(page, mobile, '#btn-howto-ok');
  let st = await waitFor(page, (s) => s.screen === 'playing' && s.mode === 'endless', { label: 'endless start' });
  await sleep(700);
  check(`${name}: tap hint shown`, await page.isVisible('#hint'));
  // first launch with a real, well-timed input; then let the test autopilot fly.
  // wouldLand(0, 8): the tap must land whether it reaches the page before the next tick or up to
  // 8 ticks later (input round-trip latency); checking only 1..6 made this flaky (~1 in 3 runs).
  await page.waitForFunction(() => window.__orbithop.wouldLand(0, 8), null, { polling: 16, timeout: 15000 });
  await playerTap(page, mobile);
  await waitFor(page, (s) => s.planet >= 1 || s.screen !== 'playing', { label: 'first hop', timeout: 8000 });
  st = await state(page);
  check(`${name}: real input launches the ship`, st.planet >= 1, `planet=${st.planet} screen=${st.screen}`);
  await page.evaluate(() => window.__orbithop.setAutopilot('ace'));
  await page.evaluate(() => window.__orbithop.setSpeed(2));
  st = await waitFor(page, (s) => s.hops >= 5 || s.screen === 'results', { label: 'endless 5 hops' });
  if (st.screen === 'playing') {
    await page.evaluate(() => window.__orbithop.setSpeed(1));
    await sleep(700);
    await shot('03-endless-mid');
    // pause via button, screenshot, resume via keyboard/tap
    await press(page, mobile, '#btn-pause');
    await sleep(350);
    check(`${name}: pause works`, (await state(page)).paused === true);
    await shot('04-pause');
    await press(page, mobile, '#btn-resume');
    await sleep(200);
    check(`${name}: resume works`, (await state(page)).paused === false);
    // tab hidden -> auto pause
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    check(`${name}: pauses on tab hide`, (await state(page)).paused === true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await press(page, mobile, '#btn-resume');
    // stop flying: the orbit decays and the run ends
    await page.evaluate(() => { window.__orbithop.setAutopilot(null); window.__orbithop.setSpeed(3); });
  }
  st = await waitFor(page, (s) => s.screen === 'results', { label: 'endless results' });
  await sleep(700);
  await shot('05-endless-results');
  check(`${name}: endless reaches results`, st.screen === 'results', `hops=${st.hops} score=${st.score}`);
  await checkLayout(page, `${name} results`);
  // instant restart
  if (mobile) await press(page, mobile, '#btn-retry');
  else await page.keyboard.press('r');
  st = await waitFor(page, (s) => s.screen === 'playing' && s.hops === 0, { label: 'restart' });
  check(`${name}: instant restart`, true);
  await page.evaluate(() => window.__orbithop.setSpeed(3));
  await playerTap(page, mobile); // launch at a random moment; likely lost
  st = await waitFor(page, (s) => s.phase !== 'orbit' || s.planet > 0, { label: 'launched', timeout: 5000 });
  await waitFor(page, (s) => s.screen === 'results' || s.planet > 0, { label: 'after random launch' });
  await page.evaluate(() => window.__orbithop.setAutopilot(null));
  await waitFor(page, (s) => s.screen === 'results', { label: 'results 2' });
  // a tap that lands right as the results card appears must not trigger its buttons
  await press(page, mobile, '#btn-menu', { guard: false });
  await sleep(150);
  check(`${name}: ghost tap on fresh results is ignored`, (await state(page)).screen === 'results');
  await press(page, mobile, '#btn-menu');
  await waitFor(page, (s) => s.screen === 'title', { label: 'back to title' });
  await sleep(300);
  const bestTxt = await page.textContent('#sub-endless');
  check(`${name}: best score persisted on title`, /Best \d+/.test(bestTxt), bestTxt);

  // ---------------------------------------------------------------- Daily (random-tap policy)
  await page.evaluate(() => window.__orbithop.setSpeed(1));
  await press(page, mobile, '.mode-daily');
  st = await waitFor(page, (s) => s.screen === 'playing' && s.mode === 'daily', { label: 'daily start' });
  let midShot = false;
  let taps = 0;
  const t0 = Date.now();
  // random taps until we crash — with a smart tap mixed in now and then so the run has some length
  while ((st = await state(page)).screen === 'playing' && Date.now() - t0 < 60000) {
    if (st.phase === 'orbit') {
      // early on, mostly well-timed real taps so the run has some length; otherwise random taps
      const smart = st.hops < 4 && Math.random() < 0.8;
      if (smart) {
        await page.waitForFunction(() => window.__orbithop.wouldLand() || window.__orbithop.state.screen !== 'playing', null, { polling: 16, timeout: 15000 }).catch(() => {});
        await playerTap(page, mobile);
        taps++;
        await waitFor(page, (s) => s.phase !== 'orbit' || s.screen !== 'playing', { label: 'launch', timeout: 3000 }).catch(() => {});
      } else {
        await sleep(150 + Math.random() * 700);
        await playerTap(page, mobile);
        taps++;
      }
    }
    if (!midShot && st.hops >= 2 && st.phase === 'orbit') {
      await shot('06-daily-mid');
      midShot = true;
    }
    await sleep(80);
  }
  if (!midShot) await shot('06-daily-mid');
  st = await waitFor(page, (s) => s.screen === 'results', { label: 'daily results' });
  await sleep(700);
  await shot('07-daily-results');
  check(`${name}: daily reaches results`, taps > 0, `hops=${st.hops} real taps=${taps}`);
  await press(page, mobile, '#btn-share');
  await sleep(300);
  const share = (await state(page)).share || '';
  check(`${name}: daily share text`, /^Orbit Hop #\d+ 🚀 \d+ hops ⭐\d+/.test(share), share.split('\n')[0]);
  const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
  check(`${name}: copied to clipboard`, clip === null || clip === share, clip === null ? 'clipboard read unavailable' : 'matches');
  await page.keyboard.press('Escape');
  if ((await state(page)).screen !== 'title') await press(page, mobile, '#btn-menu');
  await waitFor(page, (s) => s.screen === 'title', { label: 'title after daily' });
  const dailySub = await page.textContent('#sub-daily');
  check(`${name}: daily best on title`, /Today's best/.test(dailySub), dailySub);

  // ---------------------------------------------------------------- Race vs 3 bots
  await press(page, mobile, '.mode-race');
  st = await waitFor(page, (s) => s.screen === 'playing' && s.mode === 'race', { label: 'race start' });
  await sleep(500);
  await shot('08-race-countdown');
  check(`${name}: race has 3 bots`, st.bots.length === 3, st.bots.map((b) => b.name).join(','));
  const boardTxt = await page.textContent('#race-board');
  check(`${name}: race board labels bots`, (boardTxt.match(/BOT/g) || []).length === 3, boardTxt);
  await page.evaluate(() => window.__orbithop.setAutopilot('ace'));
  st = await waitFor(page, (s) => s.countdown <= 0, { label: 'countdown' });
  await page.evaluate(() => window.__orbithop.setSpeed(2));
  st = await waitFor(page, (s) => s.hops >= 6 || s.screen !== 'playing', { label: 'race mid' });
  if (st.screen === 'playing') {
    await page.evaluate(() => window.__orbithop.setSpeed(1));
    await sleep(600);
    await shot('09-race-mid');
    await page.evaluate(() => window.__orbithop.setSpeed(4));
  }
  st = await waitFor(page, (s) => s.screen === 'results', { label: 'race results', timeout: 120000 });
  await sleep(800);
  await shot('10-race-results');
  const rows = await page.$$eval('#res-race li', (els) => els.map((e) => e.textContent));
  check(`${name}: race results table`, rows.length === 4 && rows.filter((r) => /BOT/.test(r)).length === 3, rows.join(' | '));
  check(`${name}: bots finished or crashed`, st.bots.every((b) => b.phase === 'finished' || b.phase === 'dead'), JSON.stringify(st.bots));
  await checkLayout(page, `${name} race results`);
  const raceShare = await page.evaluate(() => window.__orbithop.resultText());
  check(`${name}: race result text`, /Race vs 3 bots/.test(raceShare), raceShare.split('\n')[0]);

  // credits dialog
  await press(page, mobile, '#btn-menu');
  await waitFor(page, (s) => s.screen === 'title', { label: 'title after race' });
  await press(page, mobile, '#btn-credits');
  await sleep(300);
  await shot('11-credits');
  await press(page, mobile, '#btn-credits-ok');

  check(`${name}: 0 console/page errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
  return errors.length;
}

async function quickViewport(browser, base, vp) {
  console.log(`\n▶ ${vp.name} (${vp.options.viewport.width}x${vp.options.viewport.height}) quick check`);
  const ctx = await browser.newContext(vp.options);
  await ctx.route(/gc\.zgo\.at|goatcounter\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' })); // analytics stubbed in tests
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.goto(base + '/?skiphowto');
  await page.waitForFunction(() => !!window.__orbithop);
  await sleep(1000);
  await page.screenshot({ path: path.join(SHOTS, `${vp.name}-01-title.png`) });
  await checkLayout(page, `${vp.name} title`);
  await page.evaluate(() => { window.__orbithop.setAutopilot('ace'); window.__orbithop.setSpeed(2); window.__orbithop.start('endless'); });
  await waitFor(page, (s) => s.hops >= 4 || s.screen === 'results', { label: 'landscape play' });
  await page.evaluate(() => window.__orbithop.setSpeed(1));
  await sleep(500);
  await page.screenshot({ path: path.join(SHOTS, `${vp.name}-02-play.png`) });
  await page.evaluate(() => { window.__orbithop.setAutopilot(null); window.__orbithop.setSpeed(4); });
  await waitFor(page, (s) => s.screen === 'results', { label: 'landscape results' });
  await sleep(700);
  await page.screenshot({ path: path.join(SHOTS, `${vp.name}-03-results.png`) });
  await checkLayout(page, `${vp.name} results`);
  check(`${vp.name}: 0 console/page errors`, errors.length === 0, errors.slice(0, 5).join(' | '));
  await ctx.close();
  return errors.length;
}

const srv = await serve();
const base = `http://127.0.0.1:${srv.port}`;
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
const errCounts = {};
try {
  errCounts.desktop = await runViewport(browser, base, { name: 'desktop', mobile: false, options: { viewport: { width: 1280, height: 800 } } });
  errCounts.phone = await runViewport(browser, base, { name: 'phone', mobile: true, options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
  errCounts.landscape169 = await quickViewport(browser, base, { name: 'embed-960x540', options: { viewport: { width: 960, height: 540 } } });
  errCounts.phoneLandscape = await quickViewport(browser, base, { name: 'phone-landscape', options: { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } });
} catch (e) {
  check('e2e run completed without exceptions', false, e.stack || String(e));
} finally {
  await browser.close();
  srv.close();
}
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\nE2E: ${pass} passed, ${fail} failed · console errors per viewport: ${JSON.stringify(errCounts)}`);
console.log(`Screenshots: ${SHOTS}`);
fs.writeFileSync(path.join(SHOTS, 'e2e-summary.json'), JSON.stringify({ pass, fail, errCounts, results }, null, 2));
process.exit(fail ? 1 : 0);
