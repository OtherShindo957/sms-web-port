# web/ — Super Mario Sunshine Web (browser build)

The browser build of the port. Design and status: [docs/WEB_PORT_PLAN.md](../docs/WEB_PORT_PLAN.md); log: [docs/WEB_DEVLOG.md](../docs/WEB_DEVLOG.md).

| Path | What |
| --- | --- |
| `build.sh` | configure `build/web/` with Emscripten and build (default target `sms_web_runtime`) |
| `serve.py` | local server with the COOP/COEP headers wasm threads need |
| `CMakeLists.txt` | browser targets: `sms_web_runtime`, `sms_web_game`, `sms_web_site` |
| `runtime/` | browser-only C++: runtime check (`web_main.cpp`), main-thread WebGL 2 (`web_gl.cpp`), game boot hook (`web_boot.cpp`) |
| `shell/` | the page: `index.html`, `app.js`, `import-worker.js` |
| `tests/` | `smoke.mjs` (runtime check, 20 checks), `boot.mjs` (boots the full game), `make_test_disc.py` (synthetic discs, no game data) |

## Toolchain

The Emscripten SDK, installed per user (nothing system-wide):

```sh
git clone https://github.com/emscripten-core/emsdk.git ~/dev/emsdk
~/dev/emsdk/emsdk install latest && ~/dev/emsdk/emsdk activate latest
```

`build.sh` finds it through `EMSDK`, `emcc` on `PATH`, or `~/dev/emsdk`. Also needed: `cmake`, `make`, `patch`, `python3`, `git`. Tested with emcc 6.0.12.

## Build and run

```sh
web/build.sh                       # build/web/site/: page + sms.{js,wasm} (runtime check)
web/build.sh sms_web_game          # + sms-game.{js,wasm}: the whole game (does not render yet)
python3 web/serve.py               # http://127.0.0.1:8080/
```

Open the page, import your GMSE01 image, press Play: the runtime check reads the image through OPFS and creates the WebGL 2 context.
`http://127.0.0.1:8080/?module=game` starts the full game build instead (boots into `SMS_main`; no picture yet).
`-DSMS_WEB_ASSERTIONS=ON` (in `build/web`) adds Emscripten's runtime assertions to `sms_web_game`.

## Tests

```sh
(cd web/tests && npm install)      # Playwright; uses the system Chrome if its own browsers are not installed
node web/tests/smoke.mjs           # milestones 1-2
node web/tests/boot.mjs [IMAGE]    # full game boot log; synthetic image by default
```

`SMS_TEST_BROWSER=/path/to/chrome` picks the browser. The disc image given to `boot.mjs` is copied only into the throwaway test browser profile.

## Privacy

The page never sends the disc image anywhere: it is read with `File.slice` and written to the origin-private file system of this site in this browser. Removing it (the page's button, or clearing site data) deletes it. Never put a disc image, or anything extracted from one, in this repository or in a deployed site.
