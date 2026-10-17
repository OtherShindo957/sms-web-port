#!/usr/bin/env bash
# web/build.sh [TARGET...]
#
# Builds the browser version into build/web/ with Emscripten:
#   build/web/site/   index.html, app.js, sms.js, sms.wasm (serve with web/serve.py)
# TARGETs default to sms_web_runtime. `web/build.sh sms_game` compiles the
# decompiled game as a wasm library (the porting work in progress).
# Finds Emscripten through EMSDK, emcc on PATH, or ~/dev/emsdk.
# JOBS=n limits parallel compiler jobs. KEEP_GOING=1 keeps compiling past
# failing units (to collect every error at once).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v emcmake >/dev/null 2>&1; then
  for env in "${EMSDK:-}/emsdk_env.sh" "$HOME/dev/emsdk/emsdk_env.sh" "$HOME/emsdk/emsdk_env.sh"; do
    if [[ -f "$env" ]]; then
      # shellcheck disable=SC1090
      source "$env" >/dev/null 2>&1
      break
    fi
  done
fi
command -v emcmake >/dev/null 2>&1 || {
  echo "Emscripten not found: install the emsdk (docs/WEB_PORT_PLAN.md#toolchain) or set EMSDK." >&2
  exit 1
}
for p in cmake make patch python3 git; do
  command -v "$p" >/dev/null 2>&1 || { echo "Missing $p" >&2; exit 1; }
done

git submodule update --init decomp
bdir=build/web
jobs=${JOBS:-$(nproc 2>/dev/null || echo 4)}
targets=("$@")
(( ${#targets[@]} )) || targets=(sms_web_runtime)

emcmake cmake -S . -B "$bdir" -DCMAKE_BUILD_TYPE=${BUILD_TYPE:-RelWithDebInfo}
make_flags=()
[[ "${KEEP_GOING:-0}" == 1 ]] && make_flags+=(-k)
for t in "${targets[@]}"; do
  cmake --build "$bdir" --target "$t" --parallel "$jobs" -- "${make_flags[@]}"
done
echo
echo "Built into $bdir. Serve it with: python3 web/serve.py   (then open http://127.0.0.1:8080/)"
