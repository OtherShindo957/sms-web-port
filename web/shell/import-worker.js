// Copies the user's disc image into the origin-private file system (OPFS).
// Runs in a dedicated worker so it can use a synchronous access handle, which
// every current engine supports there (FileSystemWritableFileStream is not
// available on the main thread in all of them). The file is read locally with
// File.slice; nothing is sent over the network.
'use strict';

const CHUNK = 8 << 20;

self.onmessage = async (ev) => {
  const { file, dir, name } = ev.data;
  let handle = null;
  try {
    const root = await navigator.storage.getDirectory();
    const sms = await root.getDirectoryHandle(dir, { create: true });
    // Drop the old completion marker first: a copy that does not finish must
    // never be taken for a complete image.
    try { await sms.removeEntry(name + '.json'); } catch (e) { /* none */ }
    const fh = await sms.getFileHandle(name, { create: true });
    handle = await fh.createSyncAccessHandle();
    handle.truncate(0);
    let done = 0;
    while (done < file.size) {
      const end = Math.min(done + CHUNK, file.size);
      const buf = new Uint8Array(await file.slice(done, end).arrayBuffer());
      let off = 0;
      while (off < buf.length) {
        const n = handle.write(buf.subarray(off), { at: done + off });
        if (n <= 0) throw new Error('write failed (storage full?)');
        off += n;
      }
      done = end;
      self.postMessage({ type: 'progress', done, total: file.size });
    }
    handle.flush();
    const size = handle.getSize();
    handle.close();
    handle = null;
    if (size !== file.size) throw new Error(`stored ${size} bytes of ${file.size}`);
    self.postMessage({ type: 'done', size });
  } catch (e) {
    if (handle) { try { handle.close(); } catch (e2) { /* ignore */ } }
    self.postMessage({ type: 'error', message: String(e && e.message || e) });
  }
};
