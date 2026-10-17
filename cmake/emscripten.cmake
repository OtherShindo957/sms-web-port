# Browser (Emscripten, wasm32) configuration. Included from CMakeLists.txt
# only when configured with emcmake / the Emscripten toolchain file; native
# builds never read this file. See docs/WEB_PORT_PLAN.md.
#
# Runtime model (decided in the plan):
#   - pthreads on SharedArrayBuffer: every OSThread stays a host thread, as
#     platform/os expects. The page must be cross-origin isolated
#     (COOP: same-origin, COEP: require-corp); web/serve.py sets both.
#   - main() runs on a worker (PROXY_TO_PTHREAD), so the game may block.
#   - WasmFS with the OPFS backend holds the user's disc image and memory
#     card; nothing leaves the browser.
#   - WebGL 2 (GLES 3.0) through SDL2's Emscripten port.

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "cmake/emscripten.cmake is for Emscripten builds only")
endif()

message(STATUS "SMS port: browser build (Emscripten ${EMSCRIPTEN_VERSION}, wasm32)")

# The self-tests open native windows/EGL; not meaningful in the browser.
set(SMS_GX_BUILD_TESTS OFF CACHE BOOL "" FORCE)

# Every object shares one linear memory between threads.
set(SMS_WEB_COMMON_FLAGS -pthread)
add_compile_options(${SMS_WEB_COMMON_FLAGS})
add_link_options(${SMS_WEB_COMMON_FLAGS})

# SDL2 from Emscripten's ports, as an imported target so platform/gx and the
# platform layer link it the way they link a system SDL2.
if(NOT TARGET SDL2::SDL2)
  add_library(SDL2::SDL2 INTERFACE IMPORTED GLOBAL)
  target_compile_options(SDL2::SDL2 INTERFACE -sUSE_SDL=2)
  target_link_options(SDL2::SDL2 INTERFACE -sUSE_SDL=2)
endif()
set(CMAKE_DISABLE_FIND_PACKAGE_SDL2 ON)

# Link settings shared by every browser executable.
set(SMS_WEB_LINK_FLAGS
  -sWASMFS=1
  -sPROXY_TO_PTHREAD=1
  -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=256MB
  -sMAXIMUM_MEMORY=2GB
  -sSTACK_SIZE=1MB
  -sDEFAULT_PTHREAD_STACK_SIZE=1MB
  -sPTHREAD_POOL_SIZE=4
  -sMAX_WEBGL_VERSION=2
  -sMIN_WEBGL_VERSION=2
  -sEXIT_RUNTIME=0
  -sENVIRONMENT=web,worker
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap
  -sMODULARIZE=1
  -sEXPORT_NAME=createSmsModule)
