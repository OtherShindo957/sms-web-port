# web/ — Super Mario Sunshine Web (browser build)

The browser build of the port. Design and status: [docs/WEB_PORT_PLAN.md](../docs/WEB_PORT_PLAN.md); log: [docs/WEB_DEVLOG.md](../docs/WEB_DEVLOG.md).

| Path | What |
| --- | --- |
| `build.sh` | configure `build/web/` with Emscripten and build (default targets `sms_web_game` and `sms_web_runtime`) |
| `serve.py` | local server with the COOP/COEP headers wasm threads need |
| `CMakeLists.txt` | browser targets: `sms_web_runtime`, `sms_web_game`, `sms_web_site` |
| `runtime/` | browser-only C++: runtime check (`web_main.cpp`), main-thread WebGL 2 (`web_gl.cpp`), game boot hook (`web_boot.cpp`) |
| `shell/` | the page: `index.html`, `app.js`, `import-worker.js` (disc copy into OPFS), `audio-worklet.js` (game audio) |
| `tests/` | `smoke.mjs` (runtime check, 20 checks), `import.mjs` (disc import under concurrency and failures, 25 checks), `boot.mjs` (boots the full game), `play.mjs` (fullscreen, the airstrip played to its save, loading it; needs your disc), `airstrip.input` (that playthrough's scripted input), `make_test_disc.py` (synthetic discs, no game data) |

## Toolchain

The Emscripten SDK, installed per user (nothing system-wide):

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/dev/emsdk
~/dev/emsdk/emsdk install latest && ~/dev/emsdk/emsdk activate latest
```

`build.sh` finds it through `EMSDK`, `emcc` on `PATH`, or `~/dev/emsdk`. Also needed: `cmake`, `make`, `patch`, `python3`, `git`. Tested with emcc 6.0.12.

## Build and run

```sh
web/build.sh                       # build/web/site/: game, page and diagnostic runtime
web/build.sh sms_web_game          # rebuild only the full game and page
python3 web/serve.py               # http://127.0.0.1:8080/
```

Open the page in Chrome, import your GMSE01 image, and press Play. The game then fills the screen on its own: the canvas goes fullscreen, drawn at the screen's resolution with the 4:3 picture in the middle (black bars only at the sides of a wider screen), and the page is hidden. Escape returns to the page with the game still running; **Back to the game** returns to fullscreen. Where the browser refuses fullscreen (an iframe without `allowfullscreen`, a browser setting) the game fills the window instead, and Escape returns from that too. Keys go to the game while it is shown:

| Key | GameCube | Key | GameCube |
| --- | --- | --- | --- |
| Enter | Start | Space | A (jump) |
| WASD / arrows | control stick | Shift | B |
| IJKL | C stick (camera) | E | R (spray FLUDD) |
| Q | L | V | X (change nozzle) |

Sound plays through an AudioWorkletNode at the game's 32 kHz (`?audio=0` turns it off). The game's movies play (A skips each; `?movies=0` skips them all). Escape does not quit the game in the browser, as it does on the desktop: closing the tab does. `http://127.0.0.1:8080/?module=runtime` runs the small diagnostic build instead. The old `?module=game` URL still works.

Saves go to the memory card in the site's private storage (`/opfs/sms/card-a`, as files), where they stay across reloads; importing the disc image again leaves them alone (tested), and so does removing it, which deletes only the image's files. Each card file is written beside the old one and then moved into place, so a page closed during a save keeps the old save or the new one.

The import copies the image into a slot of the site's private storage (OPFS) that is not in use, checks the copy, and only then marks it ready; imports and removals are serialized with a Web Lock (also across tabs). A failed or interrupted import leaves the image stored before ready.

Use a browser with GPU acceleration (`chrome://gpu`: "WebGL2: Hardware accelerated"): with software WebGL (SwiftShader) the game runs at a fraction of full speed. Wide lines, non-COPY logic operations and sampler LOD bias are not supported yet; gamepads are untested.

Options for `window.smsDebugEnv` (set before Play) and the game's `SMS_*` variables work as on the desktop. Browser-specific ones:

| Variable | Effect |
| --- | --- |
| `SMS_GX_SYNC_READS=1` | read EFB copies, peeks and pollution counts synchronously instead of a frame later (slower; for comparing) |
| `SMS_GX_LOG_PIXMETRIC=1` | log pixel-metric (pollution counter) reads; works on the desktop too |
| `SMS_GX_LOG_PEEKS=n` | log the first n EFB colour and depth peeks; works on the desktop too |
| `SMS_GX_STATS=n` | every n frames: time per frame and where it went, GL calls by entry point |

`-DSMS_WEB_ASSERTIONS=ON` (in `build/web`) adds Emscripten's runtime assertions to `sms_web_game`.

## Tests

```sh
(cd web/tests && npm install)      # Playwright; uses the system Chrome if its own browsers are not installed
node web/tests/smoke.mjs           # milestones 1-2
node web/tests/import.mjs          # disc import: concurrent picks and tabs, failed and interrupted imports
node web/tests/boot.mjs [IMAGE]    # full game boot log; synthetic image by default
node web/tests/boot.mjs IMAGE --seconds 150 --keyboard-play --require-render --screenshot /tmp/sms-play.png
node web/tests/play.mjs IMAGE      # fullscreen, the airstrip to its save, reload and load (about 12 minutes on a GPU)
node web/tests/play.mjs IMAGE --only fullscreen
```

`SMS_TEST_BROWSER=/path/to/chrome` picks the browser. `--keyboard-start` waits for the title animation and presses Enter through the browser. `--keyboard-play` additionally attempts to create a save, select file A, start a game and move/jump; inspect the screenshots to verify the reached scene. `--require-render` fails on renderer startup failures, shader failures, browser exceptions or WebGL validation errors. It does not assert that a level was reached.

`play.mjs` plays Delfino Airstrip from a new game with `airstrip.input`, replayed exactly under `SMS_VI_DETERMINISTIC=1` (the same presses give the same game, in the browser and natively): FLUDD, its tutorial, the goop Piranha Plant, the Shine and its save prompt (Save and Continue), the trial, and Delfino Plaza. It then reloads the page, imports the disc again, loads file A from file select and checks that the game reports one Shine, in the plaza; then it cuts the save short in the two ways a closed page can and loads again. The game's progress is read from `SMS_PRESENCE=1` lines in the log. It uses the hardware GPU unless `--swiftshader`.

The disc image given to `boot.mjs` and `play.mjs` is copied only into the throwaway test browser profile.

## Privacy

The page never sends the disc image anywhere: it is read with `File.slice` and written to the origin-private file system of this site in this browser. Removing it (the page's button, or clearing site data) deletes it. Never put a disc image, or anything extracted from one, in this repository or in a deployed site.
