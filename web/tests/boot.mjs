// Boots the full game build (build/web/site/sms-game.js) in Chromium and
// prints its log: node web/tests/boot.mjs [DISC] [--seconds N]
// DISC defaults to a synthetic image (make_test_disc.py), which has the
// shape of a GMSE01 disc but no game data, so the game stops once it reads
// its first archive; with your own GMSE01 image it boots as far as the browser
// build currently goes. The image is copied into the test browser's private
// storage only. Exit code 0 means the page loaded and the module started.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const site = path.join(repo, 'build', 'web', 'site');
const args = process.argv.slice(2);
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

let browser = null;
for (const executablePath of [process.env.SMS_TEST_BROWSER, undefined, '/usr/bin/google-chrome', '/usr/bin/chromium']) {
  try {
    browser = await chromium.launch({ executablePath, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    break;
  } catch (e) { /* next */ }
}
if (!browser) { console.log('no usable Chromium (set SMS_TEST_BROWSER)'); process.exit(1); }
const page = await browser.newPage();
page.on('console', (m) => { if (process.env.SMS_TEST_ALL_CONSOLE || m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => console.log(`[pageerror] ${e.stack || e.message}`));
await page.goto(`http://127.0.0.1:${port}/?module=game`);
await page.waitForFunction(() => !/Checking your browser/.test(document.getElementById('status').textContent));
await page.setInputFiles('#disc', disc);
await page.waitForFunction(() => /Ready|Cannot use/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
console.log('status:', await page.textContent('#status'));
const t0 = Date.now();
await page.click('#play');
await page.waitForTimeout(seconds * 1000);
console.log(`---- game log after ${((Date.now() - t0) / 1000).toFixed(0)} s ----`);
console.log((await page.textContent('#log')).trim());
console.log('status:', await page.textContent('#status'));
await browser.close();
process.exit(0);
