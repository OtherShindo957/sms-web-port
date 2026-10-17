// Boots the full game build (build/web/site/sms-game.js) in Chromium and
// prints its log: node web/tests/boot.mjs [DISC] [--seconds N]
// --env K=V passes SMS_* options to the game. DISC defaults to a synthetic image (make_test_disc.py), which has the
// shape of a GMSE01 disc but no game data, so the game stops once it reads
// its first archive; with your own GMSE01 image it boots as far as the browser
// build currently goes. The image is copied into the test browser's private
// storage only. --require-render checks renderer startup, frame progress,
// shader compilation and WebGL validation. --screenshot PATH saves the canvas.
// --keyboard-start / --keyboard-play exercise actual browser key events.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const site = path.join(repo, 'build', 'web', 'site');
const args = process.argv.slice(2);
// --env K=V (repeatable): SMS_* options for the game, as on the desktop.
const requireRender = args.includes('--require-render');
if (requireRender) args.splice(args.indexOf('--require-render'), 1);
const env = {};
const keyboardPlay = args.includes('--keyboard-play');
if (keyboardPlay) args.splice(args.indexOf('--keyboard-play'), 1);
const keyboardStart = keyboardPlay || args.includes('--keyboard-start');
if (args.includes('--keyboard-start')) args.splice(args.indexOf('--keyboard-start'), 1);
for (let i; (i = args.indexOf('--env')) >= 0;) {
  const [k, ...v] = args.splice(i, 2)[1].split('=');
  env[k] = v.join('=');
}
const screenshotAt = args.indexOf('--screenshot');
const screenshot = screenshotAt >= 0 ? args.splice(screenshotAt, 2)[1] : null;
const si = args.indexOf('--seconds');
const seconds = si >= 0 ? Number(args.splice(si, 2)[1]) : 20;
let disc = args[0];
if (!disc) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sms-web-discs-'));
  execFileSync('python3', [path.join(here, 'make_test_disc.py'), dir], { stdio: 'ignore' });
  disc = path.join(dir, 'synthetic-gmse01.iso');
}

const port = 8000 + Math.floor(Math.random() * 900);
const server = spawn('python3', [path.join(repo, 'web', 'serve.py'), site, '--port', String(port)], { stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 800));

// A persistent (throwaway) profile, as a player's browser has: an incognito
// context keeps OPFS in memory with a quota far below a disc image.
const profile = mkdtempSync(path.join(tmpdir(), 'sms-web-profile-'));
process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
let browser = null;
for (const executablePath of [process.env.SMS_TEST_BROWSER, undefined, '/usr/bin/google-chrome', '/usr/bin/chromium']) {
  try {
    browser = await chromium.launchPersistentContext(profile, {
      executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    break;
  } catch (e) { /* next */ }
}
if (!browser) { console.log('no usable Chromium (set SMS_TEST_BROWSER)'); process.exit(1); }
try {
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (/INVALID_ENUM|INVALID_OPERATION|INVALID_VALUE|WebGL.*CONTEXT_LOST/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (process.env.SMS_TEST_ALL_CONSOLE || m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack || e.message}`));
await page.goto(`http://127.0.0.1:${port}/?module=game`);
await page.waitForFunction(() => !/Checking your browser/.test(document.getElementById('status').textContent));
await page.setInputFiles('#disc', disc);
await page.waitForFunction(() => /Ready|Cannot use/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
console.log('status:', await page.textContent('#status'));
if (await page.isDisabled('#play')) throw new Error('Disc import failed; cannot start game');
await page.evaluate((e) => { window.smsDebugEnv = e; }, env);
const t0 = Date.now();
await page.click('#play');
if (keyboardStart) {
  // Wait for the title animation in game frames, not wall time: software
  // WebGL can run much slower than the game's normal 30/60 fps.
  await page.waitForFunction(() => {
    const frames = [...document.getElementById('log').textContent.matchAll(/(\d+) game frames/g)];
    return frames.length && Number(frames.at(-1)[1]) >= 1100;
  }, null, { timeout: 180000 });
  await page.locator('#canvas').click();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(500);
  await page.keyboard.up('Enter');
  if (keyboardPlay) {
    const press = async (key, ms = 500) => {
      await page.keyboard.down(key);
      await page.waitForTimeout(ms);
      await page.keyboard.up(key);
    };
    await page.waitForTimeout(12000);
    if (screenshot) await page.locator('#canvas').screenshot({ path: screenshot + '.menu.png' });
    await press('Space'); // create the memory-card file
    await page.waitForTimeout(8000);
    await press('ArrowLeft', 3000); // walk under file A
    await press('Space');
    await page.waitForTimeout(8000);
    if (screenshot) await page.locator('#canvas').screenshot({ path: screenshot + '.file.png' });
    await press('Space'); // confirm new game
    await page.waitForTimeout(8000);
    await press('Space');
    await page.waitForTimeout(Math.max(10000, seconds * 1000 - (Date.now() - t0)));
    if (screenshot) await page.locator('#canvas').screenshot({ path: screenshot + '.before-move.png' });
    await press('ArrowUp', 2000);
    await press('Space');
    await page.waitForTimeout(2000);
  } else {
    await page.waitForTimeout(Math.max(12000, seconds * 1000 - (Date.now() - t0)));
  }
} else {
  await page.waitForTimeout(seconds * 1000);
}
console.log(`---- game log after ${((Date.now() - t0) / 1000).toFixed(0)} s ----`);
const gameLog = (await page.textContent('#log')).trim();
console.log(gameLog);
console.log('status:', await page.textContent('#status'));
if (screenshot) await page.locator('#canvas').screenshot({ path: screenshot });
const passed = !requireRender || (/WebGL 2 renderer ready/.test(gameLog) && /[1-9][0-9]* game frames/.test(gameLog) && !/shader compile failed|program link failed|Aborted|RuntimeError/.test(gameLog) && errors.length === 0);
console.log(passed ? 'PASS boot checks' : `FAIL rendering checks: ${errors.slice(0, 5).join('; ')}`);
process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.kill();
}
