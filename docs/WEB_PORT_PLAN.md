# Super Mario Sunshine Web: browser port plan

A browser-native build of this port: the decompiled game compiled to WebAssembly, running locally in the player's browser, reading the player's own disc image.
No game data, ROM or Nintendo binary is ever hosted, uploaded or committed; the disc image is read with `File.slice` and copied only into the site's private browser storage (OPFS).
No server-side streaming and no emulator: the same C/C++ that the native builds compile.

Status, development log and next steps: [WEB_DEVLOG.md](WEB_DEVLOG.md). Building and testing: [web/README.md](../web/README.md).

## 1. What the native port is (investigation findings)

| Area | Native implementation | Browser consequence |
| --- | --- | --- |
| Game code | 588 decomp units (`decomp/` submodule) + 266 `decomp-patches/` applied to copies at configure time; `-std=gnu++03 -fpermissive`, `-include src/port_compat.h`, SMS.pch for 299 units | **Compiles unchanged with Emscripten's clang** (one web-only patch, below). Clang has no CP932 execution charset, so the existing macOS CP932 source mirror (`tools/darwin_cp932_mirror.py`) is used automatically. |
| Word size | 32-bit is the reference build (Linux `-m32`); 64-bit keeps game memory below 4 GiB | wasm32 is ILP32 like `-m32`, and aligns `s64`/`f64` to 8 as the GameCube does (i386 needs `aligned(8)` overrides for that). Pointer-in-`u32` slots just work. |
| Memory | MEM1 (24 MiB) mapped at **0x80000000**; `OSPhysicalToCached`, raw low-memory reads (`*(u32*)0x80000028` in `JKRHeap::initArena`) and GX physical addresses (`0x80000000 + phys`) depend on it | wasm32 linear memory can reach 4 GiB. The browser build moves the heap break to 0x80000000 and takes MEM1 there (`map_mem1`, `-sMAXIMUM_MEMORY=4GB`): the same layout as native 32-bit. The skipped range is reserved address space that browsers do not back until touched. |
| Operator new | Game `operator new/delete` (JKRHeap) renamed with `objcopy --redefine-syms` so libc++ and `platform/` use malloc | `llvm-objcopy` cannot rename wasm symbols. Replaced by asm labels in a force-included header (`src/port_web_new.h`), verified in the objects: `JKRHeap.cpp.o` defines `__sms_game_new` etc. and game call sites reference them. |
| Threads | Every `OSThread` is a host pthread; one emulated CPU, baton passed under a mutex (`platform/os/os_thread.cpp`) | Emscripten pthreads (SharedArrayBuffer workers). Requires a cross-origin isolated page (COOP/COEP headers). `main()` runs on a worker (`PROXY_TO_PTHREAD`) so the game may block like on desktop. **Verified**: the audio DSP thread starts and runs under the scheduler in Chrome. |
| Disc | `platform/disc` reads `.iso/.gcm/.ciso` with `open`/`pread`; `platform/dvd` serves the FST from it | WasmFS + OPFS backend gives real POSIX `open`/`pread` on a worker. The page copies the image into OPFS once (persists across visits). **Verified** with the unchanged `gcdisc.cpp` and `dvd.cpp`. |
| Saves | Memory card as files (`platform/card`, `SMS_SAVE_DIR`) | `SMS_SAVE_DIR=/opfs/sms/card-a`: persistent browser storage, same file format. Not yet exercised by a running game. |
| Graphics | `platform/gx`: GX register model → OpenGL **3.3 core** + GLSL 330; optional GL thread with a command queue (`gx_glthread.*`); SDL2 window or EGL headless | See §3. Compiles for wasm; does not render yet. |
| Input | `platform/pad`: SDL2 keyboard/game controllers, bindings, GameCube adapter via libusb | SDL2's Emscripten port maps keyboard and the Gamepad API; libusb adapter path is native-only. |
| Audio | DSP HLE + software mixer (`platform/audio`), output through SDL2 audio | Mixer is portable C++. Output must become Web Audio (an AudioWorklet fed from a shared ring buffer) — SDL2's Emscripten audio uses the deprecated ScriptProcessor on the main thread. |
| Crash reporting | signals, `sigaltstack`, register dumps, fork+addr2line | Not available in wasm; gated out. A trap aborts the module and the browser reports the wasm stack with function names (seen in the boot test). |
| Other OS APIs | `execinfo`, `dlfcn`, `/proc`, Discord presence, libusb | `execinfo.h` shim returns no frames on Emscripten; the rest compile against Emscripten's libc and degrade at run time (presence/adapter simply not found). |

Compiler/flag incompatibilities found: `-m32/-m64` (dropped), `-fno-pie`/`-no-pie` (meaningless, dropped), `--defsym` (wasm-ld has none: `src/lbl_80004600_darwin.c`, as on macOS), `-Wl,-Map` + `tools/savestate_ranges.py` (ELF-only; save states not wired yet), `objcopy` (above), `-msse2 -mfpmath=sse` (x86 only, already conditional). wasm floats are IEEE single/double with no excess precision and no contraction unless asked, which matches what the SSE flags achieve on x86.

## 2. Build architecture

- `CMakeLists.txt` detects `EMSCRIPTEN` and includes `cmake/emscripten.cmake`; every native path is unchanged (`if(NOT EMSCRIPTEN)` guards only).
- The game library `sms_game` and `sms_gx` are built by the same rules as native; the browser executables live in `web/CMakeLists.txt`:
  - `sms_web_runtime` → `site/sms.{js,wasm}`: the minimal runtime (milestones 1–2).
  - `sms_web_game` → `site/sms-game.{js,wasm}`: the whole game (game + GX + `platform/**` + `web/runtime/web_boot.cpp`).
  - `sms_web_site`: copies `web/shell/` (the page) into `build/web/site/`.
- `web/build.sh [targets]` finds the emsdk, configures `build/web/` with `emcmake`, builds.
- Browser-only code lives in `web/` and in `__EMSCRIPTEN__` branches of platform files; the decomp is touched only by `decomp-patches/web-01-data-export-sized-aliases.patch` (Clang rejects an alias declared as an array of unknown size).

## 3. Rendering: WebGL 2, not WebGPU

**Decision: WebGL 2** for the first playable build.

- `platform/gx` is ~10k lines targeting GL 3.3 core and generates GLSL from GX register state. WebGL 2 is OpenGL ES 3.0: the same object model, integer shader ops (needed for TEV integer math), MRT, `texelFetch`, UBOs, multisample renderbuffers. Porting is a delta, not a rewrite.
- WebGPU would mean a new backend and a WGSL shader generator (as `aurora` does), with better long-term performance but months of work before a first frame, and narrower browser support.
- WebGPU stays the later option for performance (fewer state changes, compute for texture decode).

Gaps between GL 3.3 core and WebGL 2 the GX layer must handle (from the entry points it loads):

| GL 3.3 feature used | WebGL 2 | Plan |
| --- | --- | --- |
| `#version 330 core` shaders | `#version 300 es` | header switch + `precision highp float; precision highp int;` |
| `glMapBufferRange`, `glBufferStorage` | none | `glBufferSubData` from a CPU staging buffer |
| `glDrawElementsBaseVertex`, `glMultiDrawElementsBaseVertex` | none (extension in some browsers) | rebase indices on upload, or split per batch |
| `glLogicOp` | none | GX logic op is rare in SMS; emulate the used cases in the blend/shader path |
| `glBindFragDataLocation` | none | `layout(location=N) out` |
| `glClearDepth`, `glDepthRange` (double) | `f` variants | |
| `glGetProgramBinary`, `glProgramBinary`, `glMaxShaderCompilerThreadsKHR` | none | already optional; use `KHR_parallel_shader_compile` instead |
| `glClientWaitSync` with a timeout | timeout must be 0 | poll |
| `glPointSize`, wide `glLineWidth` | `gl_PointSize` only, width 1 | GX points/lines → quads in the vertex path |
| GL thread (`gx_glthread`) | a WebGL context belongs to one thread | **The page's main thread becomes the GL thread**: the game's workers keep queueing commands; the main thread drains the queue each `requestAnimationFrame` (and when a synchronous call waits), so the canvas presents normally. `web/runtime/web_gl.cpp` already creates the context there from a worker (verified). |

Why not render on the game's worker through OffscreenCanvas: a worker's canvas only presents when that worker returns to its event loop, and the game thread never does (it blocks in its own frame loop). That would need Asyncify across the whole game. The existing GL-thread queue avoids that entirely.

## 4. Browser frontend (`web/shell/`)

- Title, **Import GameCube disc image**, local validation (CISO/ISO header, disc magic, `GMSE01`, Rev 0, truncation, RVZ/WIA/GCZ refused with a reason), storage quota check, progress, errors, **Play** enabled only when the browser has everything and a validated image is stored, **Remove stored disc**, canvas, runtime log.
- The copy runs in a worker with an OPFS sync access handle (works in Chrome, Firefox and Safari); a JSON marker is written only after a complete copy, so an interrupted import is never used.
- `navigator.storage.persist()` is requested on import.
- `web/serve.py` serves with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Any static host (GitHub Pages cannot set headers; Netlify/Cloudflare Pages can, or a `coi-serviceworker`) works the same way.

## 5. Milestones

| # | Milestone | State |
| --- | --- | --- |
| 1 | WebAssembly module initialises | **done, tested** (`web/tests/smoke.mjs`, Chrome 154) |
| 2 | Browser runtime starts (threads, OPFS disc access, WebGL 2 context) | **done, tested** (same test, 20/20 checks) |
| 2b | Whole game compiles, links and boots into `SMS_main` | **done, tested up to the first disc file the synthetic image lacks** (`web/tests/boot.mjs`) |
| 3 | Title screen renders | next: GX on WebGL 2 (§3) + a real GMSE01 image to test with |
| 4 | Main menu accepts input | SDL2 keyboard/gamepad through Emscripten; focus/pointer-lock handling in the page |
| 5 | Delfino Plaza loads | performance work: `-O3`, no DWARF in release, shader cache warm-up |
| 6 | Mario moves and interacts | |
| 7 | Audio and saves | AudioWorklet output from the DSP HLE mixer; memory card in OPFS (path already set) |
| 8 | Other levels, full game | movies (THP decoder is portable), save states (need a wasm replacement for the link-map ranges) |

## 6. Known blockers and trade-offs

- **No test disc on the build machine.** Everything past the first real archive read needs a genuine GMSE01 image; the automated tests use a synthetic image with the right structure and no game data (`web/tests/make_test_disc.py`). `node web/tests/boot.mjs /path/to/your.iso` runs the same boot test with a real image (copied only into the test browser's private storage).
- **Memory above 2 GiB.** MEM1 at 0x80000000 needs wasm memory to grow past 2 GiB (virtual). Chrome and Firefox allow 4 GiB for wasm32; this should be checked on Safari and on mobile, where the reservation may be refused. Fallback if needed: relocate MEM1 low and make `OSPhysicalToCached`/`OSCachedToPhysical` and the GX memory window (`GXPC_SetMemoryWindow`, which exists for this) use its base. That touches every low-memory access site, so it is the second choice.
- **Hardware-register sink at 0xCC000000** is not mapped in the browser. The native comment says no game code writes there any more (the write-gather pipe goes through `GXVert.h` overrides); a stray write would trap with a stack trace, so it would be found, not silently corrupt memory.
- **Cross-origin isolation** is mandatory for threads. A single-threaded build would need the OS layer rewritten on fibers + Asyncify; not planned.
- **Save states** depend on ELF link maps; disabled in the browser for now.
- **Code mods** (`platform/mods`) use `dlopen`-style loading natively; not supported in the browser build.
- **Download size**: `sms-game.wasm` is ~50 MB with DWARF debug info; a release build (`-O3`, no `-g`, `wasm-opt`) is expected to be far smaller and is served compressed.
