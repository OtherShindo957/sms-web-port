// Copies the user's disc image into the origin-private file system (OPFS).
// Runs in a dedicated worker so it can use a synchronous access handle, which
// every current engine supports there (FileSystemWritableFileStream is not
// available on the main thread in all of them). The file is read locally with
// File.slice; nothing is sent over the network.
//
// The page names the file to write: always the slot that is not in use
// (app.js), so the stored image the page last committed is never touched
// here. A copy is checked before it is reported done: its size, and its first
// and last chunk read back. The page alone commits a copy (its marker).
'use strict';

const CHUNK = 8 << 20;

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

self.onmessage = async (ev) => {
  // test: { failAfter: bytes, chunkDelayMs } from the regression tests only
  const { file, dir, name, test = {} } = ev.data;
  let handle = null;
  try {
    const root = await navigator.storage.getDirectory();
    const sms = await root.getDirectoryHandle(dir, { create: true });
    const fh = await sms.getFileHandle(name, { create: true });
    handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    let done = 0;
    let first = null, last = null;
    while (done < file.size) {
      const end = Math.min(done + CHUNK, file.size);
      const buf = new Uint8Array(await file.slice(done, end).arrayBuffer());
      if (done === 0) first = buf;
      if (end === file.size) last = { at: done, buf };
      let off = 0;
      while (off < buf.length) {
        const n = handle.write(buf.subarray(off), { at: done + off });
        if (n <= 0) throw new Error(`write failed at byte ${done + off} (browser storage full?)`);
        off += n;
      }
      done = end;
      if (test.failAfter !== undefined && done >= test.failAfter) throw new Error(`test: failing after ${done} bytes`);
      if (test.chunkDelayMs) await new Promise((r) => setTimeout(r, test.chunkDelayMs));
      self.postMessage({ type: 'progress', done, total: file.size });
    }
    handle.flush();
    const size = handle.getSize();
    if (size !== file.size) throw new Error(`browser storage kept ${size} of ${file.size} bytes (storage quota?)`);
    for (const piece of [{ at: 0, buf: first }, last]) {
      if (!piece || !piece.buf) continue;
      const back = new Uint8Array(piece.buf.length);
      handle.read(back, { at: piece.at });
      if (!same(back, piece.buf)) throw new Error(`browser storage returned different bytes at ${piece.at}`);
    }
    handle.close();
    handle = null;
    self.postMessage({ type: 'done', size });
  } catch (e) {
    if (handle) { try { handle.close(); } catch (e2) { /* ignore */ } }
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
