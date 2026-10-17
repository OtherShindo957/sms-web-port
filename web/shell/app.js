// Super Mario Sunshine Web: the page around the wasm runtime.
// - checks the browser has what the runtime needs,
// - validates a disc image locally (header only) and copies it into OPFS,
// - starts the runtime (sms.js / sms.wasm) once a valid image is stored.
// The disc image is only ever read with File.slice in this browser.
'use strict';

const DIR = 'sms';
const DISC = 'disc.img';
const DISC_PATH_IN_WASM = '/opfs/sms/disc.img';
const GC_MAGIC = 0xC2339F3D;
const FULL_DISC = 1459978240;

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), progress: $('progress'), caps: $('caps'), log: $('log'),
  disc: $('disc'), play: $('play'), remove: $('remove'), canvas: $('canvas'),
};

let capsOk = false;
let stored = null;     // metadata of the stored, validated image
let running = false;

function setStatus(text, cls = 'muted') {
  ui.status.textContent = text;
  ui.status.className = cls;
}

function log(line) {
  ui.log.textContent += line + '\n';
  ui.log.scrollTop = ui.log.scrollHeight;
}

function refreshButtons() {
  ui.play.disabled = !(capsOk && stored && !running);
  ui.remove.disabled = !stored || running;
  ui.disc.disabled = running;
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

async function smsDir(create = false) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

async function loadStoredMeta() {
  try {
    const dir = await smsDir();
    const meta = JSON.parse(await (await (await dir.getFileHandle(DISC + '.json')).getFile()).text());
    const img = await (await dir.getFileHandle(DISC)).getFile();
    if (img.size !== meta.size) return null; // an interrupted copy
    return meta;
  } catch (e) {
    return null;
  }
}

async function writeMeta(meta) {
  const dir = await smsDir(true);
  const fh = await dir.getFileHandle(DISC + '.json', { create: true });
  // createWritable is fine for a few bytes where supported; fall back to the worker-less path otherwise.
  if (fh.createWritable) {
    const w = await fh.createWritable();
    await w.write(JSON.stringify(meta));
    await w.close();
  } else {
    await new Promise((resolve, reject) => {
      const src = `onmessage=async e=>{try{const r=await navigator.storage.getDirectory();const d=await r.getDirectoryHandle('${DIR}',{create:true});` +
        `const f=await d.getFileHandle('${DISC}.json',{create:true});const h=await f.createSyncAccessHandle();h.truncate(0);` +
        `h.write(new TextEncoder().encode(e.data),{at:0});h.flush();h.close();postMessage(1)}catch(x){postMessage(String(x))}}`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => { w.terminate(); e.data === 1 ? resolve() : reject(new Error(e.data)); };
      w.postMessage(JSON.stringify(meta));
    });
  }
}

function copyToOpfs(file) {
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
    w.postMessage({ file, dir: DIR, name: DISC });
  });
}

async function importDisc(file) {
  stored = null;
  refreshButtons();
  try {
    setStatus(`Checking ${file.name}…`);
    const meta = await inspectDisc(file);
    log(`[page] ${file.name}: ${meta.title} (${meta.id} rev ${meta.rev}, ${meta.format}, ${(meta.size / 1048576).toFixed(1)} MiB)`);
    if (navigator.storage.persist) {
      const persisted = await navigator.storage.persist();
      log(`[page] persistent storage ${persisted ? 'granted' : 'not granted (the browser may evict the image under storage pressure)'}`);
    }
    const est = navigator.storage.estimate ? await navigator.storage.estimate() : null;
    if (est && est.quota && est.quota - (est.usage || 0) < meta.size) {
      throw new Error(`not enough browser storage: ${(meta.size / 1048576).toFixed(0)} MiB needed, ` +
        `${((est.quota - (est.usage || 0)) / 1048576).toFixed(0)} MiB available`);
    }
    ui.progress.hidden = false;
    ui.progress.value = 0;
    await copyToOpfs(file);
    meta.importedAt = new Date().toISOString();
    await writeMeta(meta);
    stored = meta;
    setStatus(`Ready: ${meta.title} (${meta.id}) is stored in this browser.`, 'ok');
  } catch (e) {
    setStatus(`Cannot use ${file.name}: ${e.message}`, 'bad');
    log(`[page] import failed: ${e.message}`);
  } finally {
    ui.progress.hidden = true;
    refreshButtons();
  }
}

async function removeDisc() {
  try {
    const dir = await smsDir();
    for (const n of [DISC + '.json', DISC]) { try { await dir.removeEntry(n); } catch (e) { /* gone */ } }
  } catch (e) { /* nothing stored */ }
  stored = null;
  setStatus('Stored disc removed.');
  refreshButtons();
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
  refreshButtons();
  setStatus('Starting the runtime…');
  try {
    // ?module=game boots the full game build (sms-game.js; experimental until
    // the browser renderer exists), otherwise the runtime check (sms.js).
    const game = new URLSearchParams(location.search).get('module') === 'game';
    await loadScript(game ? 'sms-game.js' : 'sms.js');
    await createSmsModule({
      smsEnv: game ? { SMS_SKIP_MOVIES: '1' } : {},
      canvas: ui.canvas,
      arguments: [DISC_PATH_IN_WASM],
      print: (t) => log(t),
      printErr: (t) => log(t),
      onRuntimeCheck: (rc) => {
        setStatus(rc === 0 ? 'Runtime check passed: wasm, threads, OPFS disc access and WebGL 2 all work. ' +
          'The game itself is not linked into the browser build yet (docs/WEB_PORT_PLAN.md).'
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

ui.disc.addEventListener('change', () => {
  const f = ui.disc.files && ui.disc.files[0];
  ui.disc.value = '';
  if (f) importDisc(f);
});
ui.remove.addEventListener('click', removeDisc);
ui.play.addEventListener('click', play);

(async () => {
  const ok = await checkCapabilities();
  if (ok) stored = await loadStoredMeta();
  if (!ok) setStatus('This browser (or this server) is missing something the game needs; see Browser support.', 'bad');
  else if (stored) setStatus(`Ready: ${stored.title} (${stored.id}) is stored in this browser.`, 'ok');
  else setStatus('Import your Super Mario Sunshine disc image to begin.');
  refreshButtons();
})();
