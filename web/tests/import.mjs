// Regression test for the page's disc import (web/shell/app.js, import-worker.js):
//   node web/tests/import.mjs [--headed]
// Two synthetic GMSE01 images (make_test_disc.py, retitled A and B and padded
// so a copy takes a while) are imported under the conditions that once broke
// the store, and after each the browser's storage itself is checked: the
// marker names a slot holding exactly the committed image, and no other image
// is left. window.smsImportTest slows copies down or fails them part way.
//   1. A second pick while an import runs is refused; the first commits intact.
//   2. Imports in two tabs at once run one after the other; the later one wins.
//   3. A failed replacement keeps the image stored before ready (and after a reload).
//   4. A failed first import leaves nothing ready.
//   5. A page closed during an import leaves the image stored before ready.
//   6. An image stored by the earlier page (disc.img) is found, and replaced cleanly.
// No game data is used. Exits non-zero on the first failed check.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const site = process.env.SMS_TEST_SITE || path.join(repo, 'build', 'web', 'site');  // SMS_TEST_SITE: another build of the page
const port = 8000 + Math.floor(Math.random() * 900);
const headed = process.argv.includes('--headed');
const MiB = 1 << 20;

const discs = mkdtempSync(path.join(tmpdir(), 'sms-web-import-'));
execFileSync('python3', [path.join(here, 'make_test_disc.py'), discs], { stdio: 'ignore' });
const base = readFileSync(path.join(discs, 'synthetic-gmse01.iso'));
function variant(letter, size) {
  const img = Buffer.alloc(size);
  base.copy(img);
  img.fill(0, 0x20, 0x60);
  img.write(`IMPORT TEST DISC ${letter}`, 0x20, 'ascii');
  img.fill(letter.charCodeAt(0), size - 4096); // a tail that tells the images apart
  const file = path.join(discs, `disc-${letter}.iso`);
  writeFileSync(file, img);
  return { file, size, title: `IMPORT TEST DISC ${letter}`, tail: letter.charCodeAt(0) };
}
const A = variant('A', 40 * MiB);
const B = variant('B', 56 * MiB);

const server = spawn('python3', [path.join(repo, 'web', 'serve.py'), site, '--port', String(port)], { stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 800));

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
  return ok;
};

let browser = null;
for (const executablePath of [process.env.SMS_TEST_BROWSER, undefined, '/usr/bin/google-chrome', '/usr/bin/chromium']) {
  try {
    browser = await chromium.launch({ executablePath, headless: !headed });
    console.log(`browser: ${executablePath || 'Playwright Chromium'} ${browser.version()}`);
    break;
  } catch (e) { /* next */ }
}
if (!browser) { console.log('FAIL no usable Chromium (set SMS_TEST_BROWSER)'); process.exit(1); }

const url = `http://127.0.0.1:${port}/?module=runtime`;
const status = (page) => page.textContent('#status');
async function open(ctx) {
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForFunction(() => !/Checking your browser/.test(document.getElementById('status').textContent));
  return page;
}
const settled = (page) => page.waitForFunction(
  () => /^(Ready|Cannot use|Import your)/.test(document.getElementById('status').textContent), null, { timeout: 120000 });
const copying = (page) => page.waitForFunction(
  () => /Copying/.test(document.getElementById('status').textContent), null, { timeout: 60000 });

// What the browser has stored: the marker, every file, and the title and
// tail byte of the file the marker names.
async function store(page) {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    let dir;
    try { dir = await root.getDirectoryHandle('sms'); } catch (e) { return { files: {}, marker: null }; }
    const files = {};
    for await (const [name, h] of dir.entries()) if (h.kind === 'file') files[name] = (await h.getFile()).size;
    let marker = null, title = null, tail = null;
    try {
      marker = JSON.parse(await (await (await dir.getFileHandle('disc.img.json')).getFile()).text());
      const img = await (await dir.getFileHandle(marker.file || 'disc.img')).getFile();
      const head = new Uint8Array(await img.slice(0x20, 0x60).arrayBuffer());
      title = String.fromCharCode(...head).replace(/\0.*$/s, '');
      tail = new Uint8Array(await img.slice(img.size - 1).arrayBuffer())[0];
    } catch (e) { /* none */ }
    return { files, marker, title, tail };
  });
}
// The store holds exactly `img`, committed in a slot, and nothing else.
function holdsOnly(st, img, what) {
  const images = Object.keys(st.files).filter((n) => n !== 'disc.img.json' && n !== 'card-a');
  return check(st.marker && st.marker.size === img.size && st.files[st.marker.file] === img.size &&
    st.title === img.title && st.tail === img.tail && images.length === 1,
  `${what}: stores ${img.title} only (${JSON.stringify({ marker: st.marker && st.marker.file, files: st.files })})`);
}
const slow = (page, ms) => page.evaluate((d) => { window.smsImportTest = { chunkDelayMs: d }; }, ms);
const failAt = (page, bytes) => page.evaluate((b) => { window.smsImportTest = { failAfter: b }; }, bytes);
const clearHooks = (page) => page.evaluate(() => { window.smsImportTest = {}; });

try {
  // 1. a second pick during an import
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await slow(page, 250);
    await page.setInputFiles('#disc', A.file);
    await copying(page);
    check(await page.isDisabled('#disc'), 'the picker is disabled during an import');
    check(await page.isDisabled('#play'), 'Play is disabled during an import');
    // the input is disabled for a user; a scripted change event still arrives
    await page.setInputFiles('#disc', B.file).catch(() => {});
    await settled(page);
    const s = await status(page);
    check(/^Ready: IMPORT TEST DISC A/.test(s), `the first import commits: "${s}"`);
    check(/ignored: another import is still running/.test(await page.textContent('#log')),
      'the second pick is refused while the first runs');
    holdsOnly(await store(page), A, 'after two picks');
    await ctx.close();
  }

  // 2. two tabs at once
  {
    const ctx = await browser.newContext();
    const one = await open(ctx), two = await open(ctx);
    await slow(one, 200);
    await slow(two, 200);
    await one.setInputFiles('#disc', A.file);
    await copying(one);
    await two.setInputFiles('#disc', B.file);
    await two.waitForFunction(() => /Waiting for an import/.test(document.getElementById('status').textContent),
      null, { timeout: 30000 }).then(() => check(true, 'the second tab waits for the first'),
      () => check(false, 'the second tab waits for the first'));
    await settled(one);
    await settled(two);
    check(/^Ready: IMPORT TEST DISC A/.test(await status(one)), 'the first tab commits A');
    check(/^Ready: IMPORT TEST DISC B/.test(await status(two)), 'the second tab then commits B');
    holdsOnly(await store(two), B, 'after imports in two tabs');
    await one.reload();
    await settled(one);
    check(/^Ready: IMPORT TEST DISC B/.test(await status(one)), 'the first tab, reloaded, sees B');
    await ctx.close();
  }

  // 3. a failed replacement
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.setInputFiles('#disc', A.file);
    await settled(page);
    check(/^Ready: IMPORT TEST DISC A/.test(await status(page)), 'A is stored');
    await failAt(page, 24 * MiB);
    await page.setInputFiles('#disc', B.file);
    await settled(page);
    const s = await status(page);
    check(/^Cannot use disc-B\.iso: test: failing/.test(s) && /IMPORT TEST DISC A .*still ready/.test(s),
      `the failed replacement is reported, A still ready: "${s}"`);
    check(!(await page.isDisabled('#play')), 'Play stays enabled for A');
    holdsOnly(await store(page), A, 'after a failed replacement');
    await clearHooks(page);
    await page.reload();
    await settled(page);
    check(/^Ready: IMPORT TEST DISC A/.test(await status(page)), 'A is still ready after a reload');
    await ctx.close();
  }

  // 4. a failed first import
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await failAt(page, 16 * MiB);
    await page.setInputFiles('#disc', A.file);
    await settled(page);
    check(/^Cannot use disc-A\.iso: test: failing/.test(await status(page)), 'the failed import is reported');
    check(await page.isDisabled('#play'), 'Play stays disabled');
    const st = await store(page);
    check(!st.marker && Object.keys(st.files).filter((n) => /\.img$/.test(n)).length === 0,
      `nothing is stored or marked ready (${JSON.stringify(st.files)})`);
    await page.reload();
    await settled(page);
    check(/^Import your/.test(await status(page)), 'nothing is ready after a reload');
    await ctx.close();
  }

  // 5. the page closed during an import
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.setInputFiles('#disc', A.file);
    await settled(page);
    await slow(page, 300);
    await page.setInputFiles('#disc', B.file);
    await copying(page);
    await page.close();
    const again = await open(ctx);
    await settled(again);
    check(/^Ready: IMPORT TEST DISC A/.test(await status(again)), 'A is ready after a page closed mid-import');
    const st = await store(again);
    check(st.marker && st.title === A.title && st.files[st.marker.file] === A.size, 'the marker still names A, intact');
    await again.setInputFiles('#disc', B.file);
    await settled(again);
    holdsOnly(await store(again), B, 'the next import after it (leftovers removed)');
    await ctx.close();
  }

  // 6. an image stored by the earlier page
  {
    const ctx = await browser.newContext();
    const page = await open(ctx);
    await page.setInputFiles('#disc', A.file);
    await settled(page);
    await page.evaluate(async () => { // move it to the old layout: disc.img and a marker without `file`
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sms');
      const meta = JSON.parse(await (await (await dir.getFileHandle('disc.img.json')).getFile()).text());
      await (await dir.getFileHandle(meta.file)).move('disc.img');
      delete meta.file;
      const w = await (await dir.getFileHandle('disc.img.json')).createWritable();
      await w.write(JSON.stringify(meta));
      await w.close();
    });
    await page.reload();
    await settled(page);
    check(/^Ready: IMPORT TEST DISC A/.test(await status(page)), 'an image in the old layout is ready');
    await page.setInputFiles('#disc', B.file);
    await settled(page);
    const st = await store(page);
    holdsOnly(st, B, 'replacing an image in the old layout');
    check(!('disc.img' in st.files), 'the old-layout image is removed');
    await ctx.close();
  }
} finally {
  await browser.close();
  server.kill();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
