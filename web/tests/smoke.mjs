// Browser smoke test for the web runtime (milestones 1-2):
//   node web/tests/smoke.mjs [--headed]
// Serves build/web/site with COOP/COEP (web/serve.py), opens it in Chromium
// through Playwright, and checks:
//   - every required capability is reported available,
//   - a non-disc file and another game's disc are rejected with a reason,
//   - a synthetic GMSE01 image (make_test_disc.py) is accepted and copied to OPFS,
//   - the stored image survives a reload (persistent storage),
//   - Play starts the wasm runtime, which reads the disc through WasmFS/OPFS
//     with platform/disc and creates a WebGL 2 context, and passes its check.
// Exits non-zero on the first failed check.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const site = path.join(repo, 'build', 'web', 'site');
const port = 8000 + Math.floor(Math.random() * 900);
const headed = process.argv.includes('--headed');

const discs = mkdtempSync(path.join(tmpdir(), 'sms-web-discs-'));
execFileSync('python3', [path.join(here, 'make_test_disc.py'), discs], { stdio: 'inherit' });

const server = spawn('python3', [path.join(repo, 'web', 'serve.py'), site, '--port', String(port)], { stdio: 'inherit' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
  return ok;
};

// SMS_TEST_BROWSER=/path/to/chrome, else Playwright's own Chromium if
// installed (npx playwright install chromium), else the system's Chrome.
const candidates = [process.env.SMS_TEST_BROWSER, undefined, '/usr/bin/google-chrome', '/usr/bin/chromium'];
let browser = null;
for (const executablePath of candidates.filter((c, i) => c !== undefined || i === 1)) {
  try {
    browser = await chromium.launch({
      executablePath,
      headless: !headed,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
    });
    console.log(`browser: ${executablePath || 'Playwright Chromium'} ${browser.version()}`);
    break;
  } catch (e) { /* next */ }
}
if (!browser) { console.log('FAIL no usable Chromium (set SMS_TEST_BROWSER)'); process.exit(1); }
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageLog = [];
  page.on('console', (m) => pageLog.push(`[console.${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => pageLog.push(`[pageerror] ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`);

  await page.waitForFunction(() => !/Checking your browser/.test(document.getElementById('status').textContent));
  const caps = await page.$$eval('#caps li', (lis) => lis.map((l) => [l.className, l.textContent]));
  for (const [cls, text] of caps) check(cls === 'ok', `capability: ${text}`);

  const status = () => page.textContent('#status');
  const importFile = async (file) => {
    await page.setInputFiles('#disc', path.join(discs, file));
    await page.waitForFunction(() => /Ready|Cannot use/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
    return status();
  };

  let s = await importFile('not-a-disc.iso');
  check(/Cannot use .*not a GameCube disc/.test(s), `random file rejected: "${s}"`);
  s = await importFile('synthetic-gale01.iso');
  check(/Cannot use .*GALE01.*GMSE01/.test(s), `other game rejected: "${s}"`);
  check(await page.isDisabled('#play'), 'Play stays disabled without a valid disc');

  s = await importFile('synthetic-gmse01.ciso');
  check(/^Ready/.test(s), `synthetic CISO accepted: "${s}"`);
  s = await importFile('synthetic-gmse01.iso');
  check(/^Ready/.test(s), `synthetic ISO accepted: "${s}"`);
  check(!(await page.isDisabled('#play')), 'Play enabled once a valid disc is stored');

  await page.reload();
  await page.waitForFunction(() => !/Checking your browser/.test(document.getElementById('status').textContent));
  s = await status();
  check(/^Ready/.test(s), `stored disc survives a reload: "${s}"`);

  await page.click('#play');
  await page.waitForFunction(() => /runtime check (passed|FAILED)|stopped|Cannot start/.test(
    document.getElementById('log').textContent + document.getElementById('status').textContent), null, { timeout: 60000 });
  const log = await page.textContent('#log');
  console.log('---- runtime log ----\n' + log.trim() + '\n---------------------');
  check(/\[web\] runtime started \(wasm32, pointer size 4/.test(log), 'wasm module initialised (milestone 1)');
  check(/\[web\] OPFS mounted/.test(log), 'WasmFS OPFS backend mounted on a pthread');
  check(/\[web\] disc: id GMSE01/.test(log), 'platform/disc read the stored image through OPFS');
  check((log.match(/\[web\] ok \/data\//g) || []).length === 3, 'file reads through the FST are correct');
  check(/\[web\] WebGL: .*WebGL 2\.0/.test(log), 'WebGL 2 context created on the main thread from a worker');
  check(/runtime check passed/.test(log), 'runtime check passed (milestone 2)');
  // What the page actually shows: a screenshot of the canvas (a WebGL canvas
  // cannot be read back after it has been composited).
  const shot = (await page.locator('#canvas').screenshot()).toString('base64');
  const px = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const t = document.createElement('canvas');
    t.width = img.width; t.height = img.height;
    const g = t.getContext('2d');
    g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(img.width >> 1, img.height >> 1, 1, 1).data);
  }, shot);
  check(px[2] > 150 && px[0] < 40, `canvas shows the runtime's clear colour (rgba ${px.join(',')})`);
  if (failures) console.log(pageLog.join('\n'));
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
