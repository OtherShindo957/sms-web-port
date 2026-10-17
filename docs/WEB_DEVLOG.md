# Super Mario Sunshine Web: development log

Newest first. Each entry says what was tested and how; "compiles" never means "works".

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
