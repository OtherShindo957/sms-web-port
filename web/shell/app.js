// Super Mario Sunshine Web: the page around the wasm runtime.
// - checks the browser has what the runtime needs,
// - validates a disc image locally (header only) and copies it into OPFS,
// - starts the runtime (sms.js / sms.wasm) once a valid image is stored.
// The disc image is only ever read with File.slice in this browser.
'use strict';

const DIR = 'sms';
const GC_MAGIC = 0xC2339F3D;
const FULL_DISC = 1459978240;
const params = new URLSearchParams(location.search);
const game = params.get('module') !== 'runtime';
const audioWanted = params.get('audio') !== '0';

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), progress: $('progress'), caps: $('caps'), log: $('log'),
  disc: $('disc'), play: $('play'), remove: $('remove'), canvas: $('canvas'),
};

let capsOk = false;
let stored = null;     // metadata of the stored, validated image
let running = false;
let importing = false; // an import or removal is running in this page
let audio = null;      // { ctx, ready }: the game's output (audio-worklet.js)

function setStatus(text, cls = 'muted') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

function log(line) {
  ui.log.textContent += line + '\n';
  ui.log.scrollTop = ui.log.scrollHeight;
  if (game && line.includes('WebGL 2 renderer ready')) {
    setStatus('Game running. Click the picture to focus controls; Enter is Start, WASD moves, Space jumps, E sprays.', 'ok');
    ui.canvas.focus();
  }
}

function refreshButtons() {
  ui.play.disabled = !(capsOk && stored && !running && !importing);
  ui.remove.disabled = !stored || running || importing;
  ui.disc.disabled = running || importing;
}

// ---------------------------------------------------------------- capabilities

async function checkCapabilities() {
  const caps = [];
  const add = (name, ok, why) => caps.push({ name, ok, why });
  add('WebAssembly', typeof WebAssembly === 'object');
  add('SharedArrayBuffer (threads)', typeof SharedArrayBuffer === 'function');
  add('Cross-origin isolated', self.crossOriginIsolated === true,
      'the server must send COOP/COEP headers (use web/serve.py)');
  const gl = document.createElement('canvas').getContext('webgl2');
  add('WebGL 2', !!gl);
  let opfs = false;
  try { opfs = !!(navigator.storage && await navigator.storage.getDirectory()); } catch (e) { /* no */ }
  add('Origin-private file system', opfs);
  add('Gamepad API', 'getGamepads' in navigator, null, true);

  ui.caps.innerHTML = '';
  for (const c of caps) {
    const li = document.createElement('li');
    li.className = c.ok ? 'ok' : 'bad';
    li.textContent = (c.ok ? '✓ ' : '✗ ') + c.name + (!c.ok && c.why ? ` — ${c.why}` : '');
    ui.caps.appendChild(li);
  }
  // The gamepad API is optional; everything else is required.
  capsOk = caps.filter((c) => c.name !== 'Gamepad API').every((c) => c.ok);
  return capsOk;
}

// ------------------------------------------------------------- disc validation

const be32 = (dv, o) => dv.getUint32(o, false);
const le32 = (dv, o) => dv.getUint32(o, true);
const ascii = (bytes) => String.fromCharCode(...bytes).replace(/\0.*$/s, '');

async function readBytes(file, offset, length) {
  return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
}

// Reads the disc header the way platform/disc does; throws with a user-facing
// reason when the file is not a supported image.
async function inspectDisc(file) {
  if (file.size < 0x440) throw new Error('the file is too small to be a GameCube disc image');
  const head = await readBytes(file, 0, 16);
  const dv = new DataView(head.buffer);
  const magic4 = ascii(head.subarray(0, 4));
  let headerAt = 0;
  let format = 'ISO/GCM';
  if (magic4 === 'CISO') {
    format = 'CISO';
    const blockSize = le32(dv, 4);
    const map = await readBytes(file, 8, 1);
    if (!blockSize || !map[0]) throw new Error('CISO image without its first block');
    headerAt = 0x8000;
  } else if (magic4 === 'RVZ\x01' || magic4 === 'WIA\x01' || be32(dv, 0) === 0xB10BC001) {
    throw new Error('RVZ, WIA and GCZ images are not supported: convert to .iso in Dolphin (right-click › Convert File…)');
  }
  const h = await readBytes(file, headerAt, 0x440);
  const hv = new DataView(h.buffer);
  if (be32(hv, 0x1C) !== GC_MAGIC) throw new Error('not a GameCube disc image (no disc magic at 0x1C)');
  const id = ascii(h.subarray(0, 6));
  const rev = h[7];
  const title = ascii(h.subarray(0x20, 0x60)).trim();
  if (id !== 'GMSE01') {
    throw new Error(`this is ${title || 'another game'} (${id}); the port needs Super Mario Sunshine, North America (GMSE01)`);
  }
  if (rev !== 0) throw new Error(`this is revision ${rev} of GMSE01; the port needs Rev 0`);
  const fstOff = be32(hv, 0x424), fstSize = be32(hv, 0x428);
  if (format === 'ISO/GCM' && (fstSize < 12 || fstOff + fstSize > file.size)) {
    throw new Error('the image is truncated (its file table lies past the end of the file)');
  }
  return { id, rev, title, format, size: file.size, name: file.name, trimmed: format === 'ISO/GCM' && file.size < FULL_DISC };
}

// --------------------------------------------------------------------- storage
//
// The stored image lives in one of two slots. An import copies into the slot
// not in use, checks the copy, and only then commits it by writing the marker
// (disc.img.json: which slot, its size, the disc's details); the other slot is
// removed after. So a failed or interrupted import never touches the image the
// marker names, and the marker never names a file still being written. Imports
// and removals hold a Web Lock, so two of them (two picks, two tabs) never run
// at once. Images stored before the slots (disc.img, a marker without `file`)
// are still found.

const MARKER = 'disc.img.json';
const SLOTS = ['disc-a.img', 'disc-b.img'];
const LEGACY = 'disc.img';
const LOCK = 'sms-disc-store';

const discPathInWasm = (meta) => `/opfs/${DIR}/${meta.file}`;

async function smsDir(create = false) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

async function loadStoredMeta() {
  try {
    const dir = await smsDir();
    const meta = JSON.parse(await (await (await dir.getFileHandle(MARKER)).getFile()).text());
    meta.file = meta.file || LEGACY;
    if (meta.file !== LEGACY && !SLOTS.includes(meta.file)) return null;
    const img = await (await dir.getFileHandle(meta.file)).getFile();
    if (img.size !== meta.size) return null; // not what was committed
    return meta;
  } catch (e) {
    return null;
  }
}

// One import or removal at a time in this origin. `waiting` runs when another
// tab holds the lock, before waiting for it.
async function withStoreLock(fn, waiting) {
  if (!navigator.locks) return fn();
  return navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
    if (lock) return fn();
    if (waiting) waiting();
    return navigator.locks.request(LOCK, fn);
  });
}

async function removeEntries(names) {
  const dir = await smsDir(true);
  for (const n of names) {
    try {
      await dir.removeEntry(n);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
  }
}

async function writeMeta(meta) {
  const dir = await smsDir(true);
  const fh = await dir.getFileHandle(MARKER, { create: true });
  // createWritable replaces the file only when closed; where it is missing,
  // a worker's sync access handle writes it (a torn write is no valid JSON).
  if (fh.createWritable) {
    const w = await fh.createWritable();
    await w.write(JSON.stringify(meta));
    await w.close();
  } else {
    await new Promise((resolve, reject) => {
      const src = `onmessage=async e=>{try{const r=await navigator.storage.getDirectory();const d=await r.getDirectoryHandle('${DIR}',{create:true});` +
        `const f=await d.getFileHandle('${MARKER}',{create:true});const h=await f.createSyncAccessHandle();h.truncate(0);` +
        `h.write(new TextEncoder().encode(e.data),{at:0});h.flush();h.close();postMessage(1)}catch(x){postMessage(String(x))}}`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => { w.terminate(); e.data === 1 ? resolve() : reject(new Error(e.data)); };
      w.postMessage(JSON.stringify(meta));
    });
  }
}

function copyToOpfs(file, name) {
  return new Promise((resolve, reject) => {
    const w = new Worker('import-worker.js');
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        ui.progress.value = m.done / m.total;
        setStatus(`Copying into browser storage… ${(m.done / 1048576).toFixed(0)} / ${(m.total / 1048576).toFixed(0)} MiB`);
      } else if (m.type === 'done') { w.terminate(); resolve(m.size); }
      else { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'import worker failed')); };
    // window.smsImportTest (regression tests only): failure and delay injection
    w.postMessage({ file, dir: DIR, name, test: window.smsImportTest || {} });
  });
}

async function importDisc(file) {
  if (importing) {
    log(`[page] ${file.name} ignored: another import is still running`);
    return;
  }
  importing = true;
  refreshButtons();
  try {
    setStatus(`Checking ${file.name}…`);
    const meta = await inspectDisc(file);
    log(`[page] ${file.name}: ${meta.title} (${meta.id} rev ${meta.rev}, ${meta.format}, ${(meta.size / 1048576).toFixed(1)} MiB)`);
    if (navigator.storage.persist) {
      const persisted = await navigator.storage.persist();
      log(`[page] persistent storage ${persisted ? 'granted' : 'not granted (the browser may evict the image under storage pressure)'}`);
    }
    await withStoreLock(async () => {
      // what is committed now (another tab may have changed it while we waited)
      const current = await loadStoredMeta();
      const target = current && current.file === SLOTS[0] ? SLOTS[1] : SLOTS[0];
      // leftovers of failed imports, and the slot about to be written
      await removeEntries([LEGACY, ...SLOTS].filter((n) => !current || n !== current.file));
      const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
      if (est && est.quota && est.quota - (est.usage || 0) < meta.size) {
        throw new Error(`not enough browser storage: ${(meta.size / 1048576).toFixed(0)} MiB needed, ` +
          `${((est.quota - (est.usage || 0)) / 1048576).toFixed(0)} MiB available`);
      }
      ui.progress.hidden = false;
      ui.progress.value = 0;
      try {
        await copyToOpfs(file, target);
      } catch (e) {
        await removeEntries([target]).catch(() => {}); // free the space now; nothing names it
        throw e;
      }
      meta.file = target;
      meta.importedAt = new Date().toISOString();
      await writeMeta(meta); // the commit
      stored = meta;
      try {
        await removeEntries([LEGACY, ...SLOTS].filter((n) => n !== target));
      } catch (e) {
        log(`[page] the previous image stays until the next import: ${e.message}`);
      }
    }, () => setStatus('Waiting for an import or removal in another tab to finish…'));
    setStatus(`Ready: ${stored.title} (${stored.id}) is stored in this browser.`, 'ok');
  } catch (e) {
    // whatever is committed: the image stored before, after a failed replacement
    stored = await loadStoredMeta();
    setStatus(`Cannot use ${file.name}: ${e.message}` +
      (stored ? ` The image stored before, ${stored.title} (${stored.id}), is still ready.` : ''), 'bad');
    log(`[page] import failed: ${e.message}`);
  } finally {
    importing = false;
    ui.progress.hidden = true;
    refreshButtons();
  }
}

async function removeDisc() {
  importing = true;
  refreshButtons();
  try {
    // the marker first: a removal cut short never leaves it naming a missing file
    await withStoreLock(() => removeEntries([MARKER, LEGACY, ...SLOTS]),
      () => setStatus('Waiting for an import or removal in another tab to finish…'));
    stored = null;
    setStatus('Stored disc removed.');
  } catch (e) {
    stored = await loadStoredMeta();
    setStatus(`Cannot remove the stored disc: ${e.message}`, 'bad');
  } finally {
    importing = false;
    refreshButtons();
  }
}

// ----------------------------------------------------------------------- audio

// Browsers start audio only from a user gesture: the context is made in the
// Play click, at the game's 32 kHz, and the worklet joins it once the game
// hands over its sample ring (Module.smsAudioStart, from platform/audio/ai.cpp).
function createAudio() {
  if (!game || !audioWanted || typeof AudioWorkletNode !== 'function') return null;
  try {
    const ctx = new AudioContext({ sampleRate: 32000, latencyHint: 'interactive' });
    return { ctx, ready: ctx.audioWorklet.addModule('audio-worklet.js') };
  } catch (e) {
    log(`[page] no audio: ${e.message}`);
    return null;
  }
}

function startGameAudio(ring) {
  if (!audio) return false;
  audio.ready.then(() => {
    const node = new AudioWorkletNode(audio.ctx, 'sms-audio', {
      numberOfInputs: 0, outputChannelCount: [2], processorOptions: ring });
    node.connect(audio.ctx.destination);
    audio.node = node;
    return audio.ctx.resume();
  }).then(() => log(`[page] audio: ${audio.ctx.state}, ${audio.ctx.sampleRate} Hz` +
    (audio.ctx.state === 'running' ? '' : ' (click the picture to start it)')))
    .catch((e) => log(`[page] audio failed: ${e.message}`));
  return true;
}

// --------------------------------------------------------------------- runtime

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`cannot load ${src} (was the runtime built? see web/README.md)`));
    document.head.appendChild(s);
  });
}

async function play() {
  running = true;
  audio = createAudio();  // before any await: needs the click
  refreshButtons();
  setStatus('Starting the runtime…');
  try {
    // The game is the default; ?module=runtime runs the small diagnostic build.
    await loadScript(game ? 'sms-game.js' : 'sms.js');
    const disc = discPathInWasm(stored);
    await createSmsModule({
      // window.smsDebugEnv (tests) adds or overrides SMS_* options.
      smsEnv: game ? Object.assign({ SMS_SKIP_MOVIES: '1', SMS_DISC_IMAGE: disc }, audioWanted ? {} : { SMS_AUDIO: '0' },
        window.smsDebugEnv || {}) : {},
      smsAudioStart: startGameAudio,
      canvas: ui.canvas,
      arguments: [disc],
      print: (t) => log(t),
      printErr: (t) => log(t),
      onRuntimeCheck: (rc) => {
        setStatus(rc === 0 ? 'Runtime check passed: wasm, threads, OPFS disc access and WebGL 2 all work. ' +
          'Reload without ?module=runtime to play the game.'
          : `Runtime check failed (code ${rc}); see the log.`, rc === 0 ? 'ok' : 'bad');
      },
      onAbort: (what) => { setStatus(`The runtime stopped: ${what}`, 'bad'); },
    });
  } catch (e) {
    setStatus(`Cannot start: ${e.message}`, 'bad');
    running = false;
    refreshButtons();
  }
}

// ------------------------------------------------------------------------ boot

// A trap or a failed call on this thread stops the game without a word in the
// status line otherwise (the workers wait on it forever).
window.addEventListener('error', (e) => {
  if (running) setStatus(`The game stopped: ${e.message}`, 'bad');
});

ui.disc.addEventListener('change', () => {
  const f = ui.disc.files && ui.disc.files[0];
  ui.disc.value = '';
  if (f) importDisc(f);
});
ui.remove.addEventListener('click', removeDisc);
ui.play.addEventListener('click', play);
ui.canvas.addEventListener('click', () => {
  ui.canvas.focus();
  if (audio && audio.ctx.state !== 'running') audio.ctx.resume();
});
ui.canvas.addEventListener('keydown', (event) => {
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) event.preventDefault();
});

(async () => {
  const ok = await checkCapabilities();
  if (ok) stored = await loadStoredMeta();
  if (!ok) setStatus('This browser (or this server) is missing something the game needs; see Browser support.', 'bad');
  else if (stored) setStatus(`Ready: ${stored.title} (${stored.id}) is stored in this browser.`, 'ok');
  else setStatus('Import your Super Mario Sunshine disc image to begin.');
  refreshButtons();
})();
