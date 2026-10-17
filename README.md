# Super Mario Sunshine Web

**Super Mario Sunshine running in a web browser**: the [Super Mario Sunshine PC port](https://github.com/chasem-dev/sms-pc-port) compiled to WebAssembly, drawing with WebGL 2 and playing sound through Web Audio.

This project takes the native PC port, which runs the game from its [matching decompilation](https://github.com/chasem-dev/sms-english), and turns it into a web port: the same game code, built with Emscripten, with the parts that talked to the desktop (OpenGL, SDL audio, files, threads, the window) replaced by their browser equivalents.

**No game data is included.** You bring your own disc image (Super Mario Sunshine, North America, GMSE01 Rev 0). The page checks it and copies it into your browser's private storage; it never leaves your computer.

> **Status: experimental.** Delfino Airstrip plays from a new game through to Delfino Plaza, with saving and loading. The rest of the game is not tested yet. Tested in Chrome on Linux with an Intel GPU.

## What works

| | |
| --- | --- |
| **Game** | Title, memory card, file select, new game, Delfino Airstrip played through (FLUDD, its tutorial, cleaning goop, the goop Piranha Plant, the Shine), the trial, Delfino Plaza |
| **Graphics** | WebGL 2, about 60 fps in Delfino Plaza on an integrated Intel GPU (50-60 in its busiest view); the goop counters match the desktop build exactly |
| **Fullscreen** | Play shows the game alone, fullscreen, at your screen's resolution (4:3, black bars only at the sides); Escape returns to the page |
| **Sound** | Music and effects through an AudioWorklet at the game's own 32 kHz |
| **Movies** | The game's cutscenes play (A skips one) |
| **Saves** | Memory card saves stay in the browser across reloads, and survive importing the disc again |
| **Input** | Keyboard (gamepads untested) |

How it was tested, and what each change fixed: [docs/WEB_DEVLOG.md](docs/WEB_DEVLOG.md).

## Play it locally

You need Linux (tested on Linux Mint; macOS should work but is untested) with `git`, `cmake`, `make`, `python3`, the [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html), and a Chromium-based browser with hardware graphics acceleration.

```sh
# 1. the source, with the decompilation submodule
git clone --recursive -b feature/web-playable https://github.com/OtherShindo957/sms-web-port.git
cd sms-web-port

# 2. Emscripten, installed for your user (once)
git clone https://github.com/emscripten-core/emsdk.git ~/dev/emsdk
~/dev/emsdk/emsdk install latest && ~/dev/emsdk/emsdk activate latest

# 3. build and serve
web/build.sh                # the first build compiles about 600 game files
python3 web/serve.py        # http://127.0.0.1:8080/
```

Open http://127.0.0.1:8080/ in Chrome, choose **Import GameCube disc image…** and pick your `.iso`, `.gcm` or Dolphin `.ciso`, then press **Play**.

The server matters: the game uses threads, which browsers allow only on pages served with cross-origin isolation headers (`web/serve.py` sends them). Opening `index.html` as a file will not work.

### Controls

| Key | GameCube | Key | GameCube |
| --- | --- | --- | --- |
| WASD / arrows | control stick | Space | A (jump) |
| IJKL | C stick (camera) | Shift | B |
| E | R (spray FLUDD) | V | X (change nozzle) |
| Q | L | Enter | Start |

Escape leaves fullscreen; **Back to the game** returns to it.

### Page options

| Address | Effect |
| --- | --- |
| `?audio=0` | no sound |
| `?movies=0` | skip the game's movies |
| `?module=runtime` | run a small diagnostic build instead of the game (checks threads, storage and WebGL 2) |

More, for developers (`window.smsDebugEnv` and the `SMS_*` switches): [web/README.md](web/README.md).

## How it works

| Desktop port | Web port |
| --- | --- |
| Native executable | WebAssembly (`sms-game.wasm`), built with Emscripten |
| One host thread per game thread | Web Workers sharing memory (`SharedArrayBuffer`) |
| OpenGL 3.3 | WebGL 2, driven from the page's main thread |
| Disc image read from a file | Disc image copied into the Origin Private File System (OPFS) |
| Memory card folder | `card-a` in OPFS |
| SDL audio | AudioWorklet reading a ring buffer in shared memory |
| SDL window | The page's canvas, fullscreen on Play |

The design, the problems that came up, and the milestones: [docs/WEB_PORT_PLAN.md](docs/WEB_PORT_PLAN.md).

## Tests

```sh
(cd web/tests && npm install)
node web/tests/smoke.mjs     # the runtime: wasm, threads, storage, WebGL 2
node web/tests/import.mjs    # disc import, including two at once and failed imports
node web/tests/play.mjs "rom/Super Mario Sunshine (USA, Canada).ciso"
```

`play.mjs` uses your disc: it checks fullscreen, plays Delfino Airstrip from a new game to its save with scripted input, reloads, loads the save and checks the progress (about 12 minutes). The other two need no game data.

## Repository layout

```
web/              the browser build: page, runtime glue, build script, server, tests
platform/         the port's replacements for the GameCube SDK (graphics, audio, disc, input, OS),
                  shared by the desktop and web builds
decomp/           the decompilation (git submodule)
decomp-patches/   PC changes applied to copies of decompilation sources at build time
src/              entry point and compatibility headers
rom/              your disc image (ignored by git; never commit it)
docs/             the web port's plan and log, and the desktop port's documentation
```

## The desktop build

The native PC port still builds from this repository (`./build.sh`, `./run.sh`). Its README, with its options, controls and supported systems, is kept in [docs/NATIVE-PORT.md](docs/NATIVE-PORT.md); build details are in [BUILD.md](BUILD.md).

## Credits and license

Built on the [Super Mario Sunshine PC port](https://github.com/chasem-dev/sms-pc-port) by chasem-dev and its contributors, and the [GMSE01 decompilation](https://github.com/chasem-dev/sms-english). The web port is by OtherShindo957.

MIT License; see [LICENSE](LICENSE). Super Mario Sunshine is © Nintendo; this project contains no game data, and you need your own copy of the game to play.
