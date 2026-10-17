// Plays the real game in Chromium and checks what a player does with it:
//   node web/tests/play.mjs DISC [--headed] [--swiftshader] [--only fullscreen|save]
// DISC is your own GMSE01 image; it is copied into the test browser's private
// storage only. Uses the hardware GPU (ANGLE on GL) unless --swiftshader.
//   1. Fullscreen: Play shows the game alone, fullscreen (#stage, holding only
//      the canvas), drawn at the screen's size with the page's UI hidden; sound
//      runs; keys reach the game (Start leaves the title); Escape returns to the
//      page with the game still running, and "Back to the game" goes back.
//      A refused fullscreen leaves the game filling the window, playable.
//   2. Save: a new game on a fresh memory card, Delfino Airstrip played from the
//      normal new game to its Shine (web/tests/airstrip.input: SMS_AUTOPRESS
//      presses, replayed exactly with SMS_VI_DETERMINISTIC; no warps), "Save and
//      Continue" at the save prompt, on to Delfino Plaza. The save file must be
//      in the browser's storage (OPFS) with the Shine in it.
//   3. Load: the page reloaded and the disc imported again (the save must stay),
//      file A loaded from file select: the game reports 1 Shine, in the plaza.
//   4. Interrupted saves: a save cut while writing (a partial .tmp beside the
//      file) or between its two steps (only the complete .tmp) still loads.
// The whole test takes about 12 minutes on a GPU (the airstrip run about 3, its
// trial movie and each load about 1-2). Exits non-zero if a check fails.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const site = process.env.SMS_TEST_SITE || path.join(repo, 'build', 'web', 'site');
const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
const headed = flag('--headed');
const swiftshader = flag('--swiftshader');
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args.splice(onlyAt, 2)[1] : null;
const disc = args[0];
if (!disc) { console.log('usage: node web/tests/play.mjs DISC [--headed] [--swiftshader] [--only fullscreen|save]'); process.exit(2); }

const airstrip = readFileSync(path.join(here, 'airstrip.input'), 'utf8').split('\n')
  .filter((l) => l && !l.startsWith('#')).join(',');
// From the title to file A's file menu and START, with a card that has a file.
const LOAD = 'START@1400,START@2200,STICK_LEFT@3100,A@3250,A@3450,A@3800';
const scripted = (presses) => ({ SMS_VI_DETERMINISTIC: '1', SMS_AUDIO: '0', SMS_PRESENCE: '1', SMS_AUTOPRESS: presses });

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`);
  if (!ok) failures++;
  return ok;
};

const port = 8000 + Math.floor(Math.random() * 900);
const server = spawn('python3', [path.join(repo, 'web', 'serve.py'), site, '--port', String(port)], { stdio: 'ignore' });
process.on('exit', () => server.kill());
await new Promise((r) => setTimeout(r, 800));

// A persistent profile, as a player's browser has (OPFS on disk, a real quota).
const profile = mkdtempSync(path.join(tmpdir(), 'sms-web-play-'));
process.on('exit', () => rmSync(profile, { recursive: true, force: true }));
const gpu = swiftshader ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=gl-egl'];
let ctx = null;
for (const executablePath of [process.env.SMS_TEST_BROWSER, '/usr/bin/google-chrome', undefined, '/usr/bin/chromium']) {
  try {
    ctx = await chromium.launchPersistentContext(profile, {
      executablePath, headless: !headed, args: gpu, viewport: { width: 1280, height: 720 } });
    break;
  } catch (e) { /* next */ }
}
if (!ctx) { console.log('FAIL no usable Chromium (set SMS_TEST_BROWSER)'); process.exit(1); }

const page = ctx.pages()[0] || await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || /INVALID_ENUM|INVALID_OPERATION|INVALID_VALUE|CONTEXT_LOST/.test(m.text())) errors.push(m.text());
});

const gameLog = () => page.textContent('#log');
const presence = async () => [...(await gameLog()).matchAll(/\[presence\] (\{.*\})/g)].map((m) => JSON.parse(m[1]));
const waitLog = (re, timeout) => page.waitForFunction((src) => new RegExp(src).test(document.getElementById('log').textContent),
  re.source, { timeout, polling: 1000 });
// Presence lines are printed when what the player does changes.
const waitPresence = (pred, timeout) => page.waitForFunction((src) => {
  const lines = [...document.getElementById('log').textContent.matchAll(/\[presence\] (\{.*\})/g)].map((m) => JSON.parse(m[1]));
  return lines.some(new Function('p', `return ${src}`));
}, pred, { timeout, polling: 1000 });
async function openPage() {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => !/Checking your browser/.test(document.getElementById('status').textContent));
}
async function importDisc() {
  await page.setInputFiles('#disc', disc);
  await page.waitForFunction(() => /^(Ready|Cannot use)/.test(document.getElementById('status').textContent), null, { timeout: 600000 });
  return page.textContent('#status');
}
// The memory card's files in OPFS: name -> size
const cardFiles = () => page.evaluate(async () => {
  const out = {};
  try {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('sms')).getDirectoryHandle('card-a');
    for await (const [n, h] of dir.entries()) if (h.kind === 'file') out[n] = (await h.getFile()).size;
  } catch (e) { /* none */ }
  return out;
});
const clearCard = () => page.evaluate(async () => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sms');
  try { await dir.removeEntry('card-a', { recursive: true }); } catch (e) { /* none */ }
});
const view = () => page.evaluate(() => {
  const r = document.getElementById('canvas').getBoundingClientRect();
  const hidden = [...document.querySelectorAll('main > :not(#stage)')].every((e) => getComputedStyle(e).display === 'none');
  return {
    fullscreen: document.fullscreenElement ? document.fullscreenElement.id : null,
    playing: document.body.classList.contains('playing'), hidden,
    css: [Math.round(r.width), Math.round(r.height)], buffer: [document.getElementById('canvas').width, document.getElementById('canvas').height],
    dpr: devicePixelRatio, inner: [innerWidth, innerHeight],
    play: [document.getElementById('play').textContent, document.getElementById('play').disabled],
    audio: typeof audio !== 'undefined' && audio ? audio.ctx.state : null,
  };
});
const frames = async () => { const m = [...(await gameLog()).matchAll(/(\d+) game frames/g)]; return m.length ? Number(m.at(-1)[1]) : 0; };

try {
  await openPage();
  console.log('import:', await importDisc());
  check(!(await page.isDisabled('#play')), 'the disc is stored and Play is enabled');

  if (!only || only === 'fullscreen') {
    // 1. fullscreen, sound and keys
    await page.evaluate(() => { window.smsDebugEnv = { SMS_PRESENCE: '1' }; });
    await page.click('#play');
    await waitLog(/WebGL 2 renderer ready/, 60000);
    await page.waitForTimeout(1500);
    let v = await view();
    check(v.fullscreen === 'stage', `Play puts the game's stage in fullscreen (${v.fullscreen})`);
    check(v.playing && v.hidden, 'the page around the game is hidden');
    check(v.css[0] === v.inner[0] && v.css[1] === v.inner[1], `the canvas fills the screen (${v.css} of ${v.inner})`);
    check(Math.abs(v.buffer[0] - v.css[0] * v.dpr) <= 2 && Math.abs(v.buffer[1] - v.css[1] * v.dpr) <= 2,
      `the game draws at the screen's resolution (${v.buffer})`);
    await page.waitForFunction(() => /audio: running/.test(document.getElementById('log').textContent), null, { timeout: 30000 })
      .then(() => check(true, 'sound is running'), () => check(false, 'sound is running'));
    // Start at the title: the game goes to file select (presence state 5, area 15)
    await page.waitForFunction(() => /(\d+) game frames/.test(document.getElementById('log').textContent) &&
      Number([...document.getElementById('log').textContent.matchAll(/(\d+) game frames/g)].at(-1)[1]) > 900, null, { timeout: 120000 });
    // the picture (the title by now): 4:3 in the middle, black bars at the sides only
    const shot = await page.screenshot();
    const bars = await page.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const px = (x, y) => [...g.getImageData(x, y, 1, 1).data].slice(0, 3);
      const black = (p) => p.every((v) => v < 8);
      const w = img.width, h = img.height, picW = Math.round(h * 4 / 3), x0 = Math.round((w - picW) / 2);
      let barBlack = true, picLit = 0;
      for (let y = 10; y < h; y += 37) {
        barBlack = barBlack && black(px(4, y)) && black(px(w - 5, y)) && black(px(x0 - 6, y)) && black(px(x0 + picW + 5, y));
        for (let x = x0 + 10; x < x0 + picW - 10; x += 61) if (!black(px(x, y))) picLit++;
      }
      return { barBlack, picLit };
    }, shot.toString('base64'));
    check(bars.barBlack && bars.picLit > 20, `4:3 picture with black bars only at the sides (${JSON.stringify(bars)})`);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.down('Enter'); await page.waitForTimeout(150); await page.keyboard.up('Enter');
      await page.waitForTimeout(2500);
    }
    await waitPresence('p.state === 5 && p.area === 15', 60000)
      .then(() => check(true, 'keys reach the game in fullscreen (Start: title to file select)'),
        () => check(false, 'keys reach the game in fullscreen (Start: title to file select)'));
    // Escape: back to the page, the game still running
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    v = await view();
    check(!v.fullscreen && !v.playing && !v.hidden, 'Escape leaves fullscreen and shows the page');
    check(v.play[0] === 'Back to the game' && !v.play[1], `Play offers to go back (${v.play})`);
    const f0 = await frames();
    await page.waitForTimeout(6000);
    check((await frames()) > f0, 'the game keeps running on the page');
    await page.click('#play');
    await page.waitForTimeout(1000);
    v = await view();
    check(v.fullscreen === 'stage' && v.playing, 'Back to the game restores fullscreen');
    check(v.audio === 'running', `sound still runs (${v.audio})`);
    // a browser that refuses fullscreen
    await page.keyboard.press('Escape');
    await openPage();
    await page.evaluate(() => {
      Element.prototype.requestFullscreen = function () { return Promise.reject(new TypeError('Permissions check failed')); };
      window.smsDebugEnv = { SMS_PRESENCE: '1' };
    });
    await page.click('#play');
    await waitLog(/WebGL 2 renderer ready/, 60000);
    await page.waitForTimeout(3000);
    v = await view();
    check(!v.fullscreen && v.playing && v.hidden && v.css[0] === v.inner[0], 'refused fullscreen: the game fills the window');
    check(/fullscreen not available/.test(await gameLog()), 'refused fullscreen is reported in the log');
    const g0 = await frames();
    await page.waitForTimeout(6000);
    check((await frames()) > g0 && !/stopped/.test(await page.textContent('#status')), 'refused fullscreen: the game runs on');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    check(!(await view()).playing, 'Escape returns to the page there too');
    check(errors.length === 0, `no page or WebGL errors (${errors.slice(0, 3).join('; ')})`);
  }

  if (!only || only === 'save') {
    // 2. the airstrip, saved
    await openPage();
    await clearCard();
    await page.evaluate((e) => { window.smsDebugEnv = e; }, scripted(airstrip));
    const t0 = Date.now();
    await page.click('#play');
    await waitPresence('p.area === 0 && p.shines === 1', 20 * 60000)
      .then(() => check(true, `the airstrip's Shine is collected (${((Date.now() - t0) / 60000).toFixed(1)} min)`),
        () => check(false, 'the airstrip\'s Shine is collected'));
    await waitPresence('p.area === 1 && p.shines === 1', 10 * 60000)
      .then(() => check(true, 'saved and on to Delfino Plaza'), () => check(false, 'saved and on to Delfino Plaza'));
    const log = await gameLog();
    const afterShine = log.slice(log.indexOf('"shines":1'));
    check(/\[card\] saved super_mario_sunshine/.test(afterShine), 'the save prompt\'s save is written to the card');
    let card = await cardFiles();
    check(card['super_mario_sunshine.dat'] === 57344 && card['super_mario_sunshine.stat'] === 108 && 'index.txt' in card,
      `the save is in the browser's storage (${JSON.stringify(card)})`);
    check(errors.length === 0, `no page or WebGL errors (${errors.slice(0, 3).join('; ')})`);

    // 3. reload (closing the game), import the disc again, load file A
    await openPage();
    console.log('import again:', await importDisc());
    card = await cardFiles();
    check(card['super_mario_sunshine.dat'] === 57344, 'importing the disc again keeps the save');
    const load = async (what) => {
      await openPage();
      await page.evaluate((e) => { window.smsDebugEnv = e; }, scripted(LOAD));
      await page.click('#play');
      await waitPresence('p.area === 1 && p.shines === 1', 5 * 60000)
        .then(() => check(true, `${what}: file A loads with its Shine, in Delfino Plaza`),
          () => check(false, `${what}: file A loads with its Shine, in Delfino Plaza`));
    };
    await load('after a reload and a new import');

    // 4. saves cut short
    const cardOp = (op) => page.evaluate(async (o) => {
      const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('sms')).getDirectoryHandle('card-a');
      const dat = await (await dir.getFileHandle('super_mario_sunshine.dat')).getFile();
      if (o === 'partial') { // stopped while writing: the start of a new file beside the old
        const w = await (await dir.getFileHandle('super_mario_sunshine.dat.tmp', { create: true })).createWritable();
        await w.write(await dat.slice(0, 8192).arrayBuffer()); await w.close();
      } else { // stopped between writing the new file and putting it in place
        try { await dir.removeEntry('super_mario_sunshine.dat.tmp'); } catch (e) { /* none */ }
        await (await dir.getFileHandle('super_mario_sunshine.dat')).move('super_mario_sunshine.dat.tmp');
      }
    }, op);
    await openPage();
    await cardOp('partial');
    await load('with a save cut while writing');
    await openPage();
    await cardOp('between');
    await load('with a save cut between its two steps');
    card = await cardFiles();
    check(card['super_mario_sunshine.dat'] === 57344, `the complete new file is put in place (${JSON.stringify(card)})`);
    check(errors.length === 0, `no page or WebGL errors (${errors.slice(0, 3).join('; ')})`);
  }
} catch (e) {
  console.log('FAIL', e.message);
  failures++;
} finally {
  await ctx.close();
  server.kill();
}
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
