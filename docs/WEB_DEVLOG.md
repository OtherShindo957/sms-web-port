# Super Mario Sunshine Web: development log

Newest first. Each entry says what was tested and how; "compiles" never means "works".

## 2026-10-17 (evening) — playable: gameplay verified, 60 fps on a GPU, audio, safe disc import

Tested with the user's GMSE01 Rev 0 `.ciso` (`rom/`, git-ignored) in Chrome 154 headless with hardware WebGL (`--use-angle=gl-egl`: ANGLE on Mesa, Intel Raptor Lake-P iGPU), driven by real browser key events, judged by screenshots; plus SwiftShader where noted.

**Gameplay (visually verified, keyboard):** title → Enter → "create a file?" → Yes (the card file is created in OPFS) → walk under block A, jump → Start → new game → Delfino Airstrip's opening (Peach's dialogue) → free control on the airstrip: running, jumping, swimming, goop slowing and hurting Mario (life meter), camera turned with IJKL. FLUDD is not picked up on the airstrip in this run (not found by hand); with `SMS_WARP=1,0,1` (Delfino Plaza right after the airstrip, FLUDD on Mario's back) spraying (E) and the hover nozzle (V, then E in the air) work.

**Fixed**

1. *Pollution counts read 0.* `GXReadPixMetric` (the goop counters, `TPollutionCounter*`, which decide when an area is clean) used `GL_SAMPLES_PASSED` queries; WebGL 2 has none, so every query failed (`beginQuery: invalid target`, hundreds per second, which also hid any other WebGL error behind Chrome's report limit). Now, while a metric counts, each batch is also drawn into a count target sharing the EFB depth with a "count pass" program (the batch's own alpha-test and clip discards, then 1/255 added per fragment), and a read sums its columns on the GPU into one `R32UI` row. Verified: Delfino Plaza's reads are 14187, 14187, 13922, 13720, 13611, 13459, 13362, 13354… — the native OpenGL build's sequence exactly (`SMS_GX_LOG_PIXMETRIC=1` on both), on ANGLE/Intel and on SwiftShader.
2. *`GLctx.getBufferSubData is not a function`.* Emscripten does not proxy `glGetBufferSubData`; called from the game worker it hit a context that exists only on the main thread, and the game stopped (the page still said "running"). `gx_web.cpp` runs it on the main thread. Its `glMapBufferRange` emulation also kept mappings per target, so two mapped pixel buffers (the colour and depth peek snapshots) shared one copy; mappings are now per buffer.
3. *30 fps.* Plaza gameplay ran at exactly 30 (each frame just over 16.7 ms, then waiting a retrace). A main-thread CPU profile showed `readPixels` stalls taking 45% of it (4 synchronous GPU reads a frame). Now on WebGL: element draws are queued instead of proxied synchronously (Emscripten's `glDrawElements` waits for the main thread, since its indices might be client memory; ours are always in a buffer); copy write-backs, peeks (depth encoded as colour for the snapshot) and pixel metrics read a frame later through pixel-pack buffers, as the desktop does by default; no fences (each one is a main-thread round trip); a frame's snapshots are fetched right after presenting, when the main thread's queue is empty; the stream buffer uploads a batch in one call. Plaza, heaviest view (750 draws, 174k vertices): 25-33 ms/frame → **17.3-18.3 ms/frame**; lighter views 16.7 (60 fps); 0 synchronous GPU reads a frame. Same scene with `SMS_GX_SYNC_READS=1`: 24-26 ms. Asynchronous colour peeks (Mario's occlusion test, every frame) give the same values as synchronous ones (1869 vs 1869+ visible, 118 vs 118 occluded, same final pixel).
4. *Audio.* `platform/audio/ai.cpp` gains a browser output: a ring of stereo frames in shared wasm memory, played by `web/shell/audio-worklet.js` in an AudioContext at 32 kHz (no resampling), a pacing thread doing what the SDL callback did (kick the CPU when low, queue more after a dry spell), and the DAC clock kept while the context is suspended. Measured with an AnalyserNode on the worklet's output: title music RMS 0.008-0.056, peaks to 0.22; no dry spell in 30 s of play after loading; suspending and resuming the context mid-game keeps the game running and the sound comes back. `?audio=0` mutes.
5. *Disc import.* Two picks (or two tabs) could copy into the same file at once, and an import overwrote the stored image in place, so a failed or interrupted replacement destroyed it, and a slow marker write could mark an image being overwritten as ready. Now: a Web Lock serializes imports and removals (also across tabs); the picker is disabled and a second pick is refused while one runs; the copy goes to the slot not in use (`disc-a.img`/`disc-b.img`), is checked (size, first and last chunk read back), and only then committed by the marker; a failed copy is deleted. Old installs (`disc.img`) are still found and replaced cleanly. `web/tests/import.mjs`: **25/25** (against the old page: the second pick is not refused, the second tab's image is lost, and a page closed mid-import loses the image stored before).
6. The page reports a main-thread error as "The game stopped" instead of staying on "Game running".

**Checks:** `smoke.mjs` 20/20; `import.mjs` 25/25; `boot.mjs` with the real disc on SwiftShader, `--require-render` into the plaza: PASS (no WebGL validation errors, no shader failures). Native 64-bit: builds; `tools/regress/regress.py --arch 64 title plaza plaza-audio` gives byte-identical hashes (14 values, frames and WAV) for this tree and for the tree before these changes (both differ from the recorded baseline on this machine, which predates them).

**Not done / open:** FLUDD pickup on the airstrip and a whole airstrip episode not played through; saving a game and loading it back not checked; gamepads untested; wide lines/points, non-COPY logic ops, sampler LOD bias; the count pass counts against the depth before its batch (exact for the goop counters, which neither test nor write depth); `sms-game.wasm` is a RelWithDebInfo build (~50 MB).

## 2026-10-17 — first WebGL game renderer

- The full game now creates a WebGL 2 context on the browser main thread via Emscripten's proxy and explicitly commits complete frames. The default page and `web/build.sh` now launch/build the game; `?module=runtime` retains the diagnostic runtime.
- Added a browser-only GL compatibility layer: GLSL ES 300 with explicit precision, fragment clipping for GX clip planes, float depth entry points, CPU buffer uploads, and rebased indices in a separate WebGL element buffer. Native builds retain their desktop paths.
- Fixed WebGL framebuffer feedback errors by clearing unused sampler-array bindings. Depth peeks encode 24-bit depth into RGB before reading it because WebGL forbids direct depth readback. Native shader caches/program binaries and the display-list arena are bypassed for the browser.
- SDL browser events are drained on the game worker each frame, which never returns to its JavaScript event loop. The page focuses the canvas, prevents movement/jump keys from scrolling, displays controls, and reports renderer startup.
- Verified title and file-select rendering with the user's local CISO in Chrome 154/SwiftShader. The game was observed running for 100 seconds without shader failures or WebGL validation errors after the depth-read fix. Software rendering is slow (roughly 9–15 fps during these runs; concurrent test browsers affected timing); this is not a hardware performance measurement.
- Existing browser runtime smoke checks: **20/20 pass**. Native Linux 64-bit target builds successfully.
- `boot.mjs` adds screenshots, real browser keyboard sequences and `--require-render` validation. A successful rendering check alone does not prove a level was reached; screenshots must be reviewed.
- Still experimental: audio is disabled; exact occlusion sample counts (pollution accounting), wide lines/points, non-COPY logic operations and sampler LOD bias need further work. Full-game compatibility and gamepads are not verified.

## 2026-10-17 (later) — the real game runs in the browser (no picture yet)

Tested with the user's own GMSE01 Rev 0 `.ciso` (kept outside the repository; copied only into a throwaway test browser profile). Chrome 154 headless, SwiftShader.

- Import: the 1.18 GB image copies into OPFS and validates. In Playwright's default incognito-style context OPFS kept only 993,954,402 of 1,180,729,920 bytes (in-memory, small quota); the page caught it and refused the image. The import worker now names that case, and `boot.mjs` uses a persistent profile, as a player's browser has.
- `GXPeekZ` (the sun's lens-flare depth test) called a null GL entry point with no context: the EFB peek was the one GX entry point without the `s_ready` guard → it now returns an untouched EFB (far depth). Native builds always have a context, so this only changes the no-context path.
- Display copies made without a context did not reach the frame hook, so the frame counter stood still → `executeCopy` reports the finished frame even with no context (presenting is a no-op then).
- `web_boot.cpp` logs a heartbeat every 5 s: game frames and VI retraces.
- **Real time** (`node web/tests/boot.mjs IMAGE --seconds 60`): 29.97 fps through the logos, then a steady 59.94 fps (+300 frames per 5 s) for the whole minute, retraces at 59.94 Hz, no traps.
- **Scripted new game** (the native `plaza` regression's input: `--env SMS_WARP=1,0,1 --env SMS_AUTOPRESS=START@1400,... --env SMS_VI_DETERMINISTIC=1`): title → Start → file select → file A → new game → `SMS_WARP: stage 1 scenario 0 shines 1` → Delfino Plaza, which then runs (with the scripted walk) for 100+ s at ~215 unthrottled frames/s. Game logic, DVD streaming from OPFS, pad input, OSThreads and the card mount all work in wasm.
- Not shown on screen: no GL context yet, so milestones 3-6 are reached in game logic only, not visually.

## 2026-10-17 — first browser build

Environment: Linux Mint 22.3, Emscripten 6.0.12 (`~/dev/emsdk`), Chrome 154 (headless, SwiftShader WebGL), Node 26, Playwright 1.64.

**Done and tested**

- `web` branch; `upstream` remote → chasem-dev/sms-pc-port.
- Emscripten configuration (`cmake/emscripten.cmake`, `web/CMakeLists.txt`, `web/build.sh`); native paths gated, not changed.
- Minimal runtime `sms_web_runtime`: module start, WasmFS OPFS mount on a pthread, the unchanged `platform/disc/gcdisc.cpp` reading the stored image (header, FST, file contents, CISO), WebGL 2 context created on the page's main thread from the worker and cleared. `web/tests/smoke.mjs`: **20/20 checks pass** (capabilities, rejection of a random file and of another game's disc, ISO and CISO import, persistence across reload, runtime check, canvas pixel from a screenshot).
- Frontend: import, validation, OPFS copy in a worker, progress, errors, Play gating, removal.
- The whole game compiles for wasm32: `sms_game` (593 units, 0 errors after one patch), `sms_gx` (0 errors after two include fixes), the whole native platform layer (0 errors after gating the native crash reporter), and **links** into `sms-game.wasm` with no undefined symbols.
- Boot test (`web/tests/boot.mjs`, synthetic disc): MEM1 at 0x80000000, `JKRHeap::initArena`, JKR heaps, GX init (no context: expected), DSP HLE audio thread started under the OSThread scheduler, DVD reads through OPFS; stops at `[dvd] path not found: Seqs/JaiSeInf.bst` (the synthetic disc has no game files) and then traps in `JAIData::initData` on the missing data.
- Native Linux 64-bit (`SMS_ARCH=64 ./build.sh`) still builds and starts with all changes. Native 32-bit not verified here (no `gcc-multilib` on this machine).

**Errors met and fixed**

1. CMake de-duplicated the second `-include` (`port_compat.h`, `port_web_new.h`), so every unit failed with "cannot specify -o when generating multiple output files" → `SHELL:` option group.
2. `llvm-objcopy: only flags for section dumping, removal, and addition are supported` for wasm → game `operator new/delete` renamed by asm labels at compile time (`src/port_web_new.h`), verified with `llvm-nm`.
3. 3× "definition of variable with array type needs an explicit size" (modhook data exports via `alias` of unsized arrays; GCC accepts, Clang does not) → `decomp-patches/web-01-data-export-sized-aliases.patch`, `__typeof__` under `__EMSCRIPTEN__` only.
4. `GL/glcorearb.h` not found → the Khronos headers already shipped for macOS (`platform/gx/third_party`).
5. `execinfo.h` not found → Emscripten branch in `src/port_include/execinfo.h` (no frames).
6. `port_runtime.cpp`: `link_map`, `pthread_threadid_np`, ucontext register dumps → native crash reporter gated out for Emscripten.
7. Page files only copied on relink → `sms_web_site` target.
8. Runtime: `memory access out of bounds` in `JKRHeap::initArena` (reads `0x80000028`; the MEM1 fallback placed it at 0x630000) → MEM1 at 0x80000000 in wasm memory via `sbrk`, `-sMAXIMUM_MEMORY=4GB`.

**Open**

- No genuine disc image available on this machine: milestone 3 needs one for testing.
- GX on WebGL 2 (see WEB_PORT_PLAN.md §3) — the next engineering task.
