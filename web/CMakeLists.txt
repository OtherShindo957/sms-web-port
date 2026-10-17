# Browser executables (Emscripten only; included from the top-level
# CMakeLists.txt after the game library sms_game is defined).
#
#   sms_web_runtime  The minimal browser runtime (milestones 1-2 of
#                    docs/WEB_PORT_PLAN.md): boots on a worker, mounts the
#                    origin-private file system, opens the user's disc image
#                    with platform/disc and creates the WebGL 2 context on the
#                    page's main thread, where the GX GL queue will run.
#                    Built by default.
#   sms_game         The decompiled game as a wasm static library (built by
#                    `cmake --build ... --target sms_game`, or SMS_WEB_GAME=ON);
#                    linked into sms_web_game below.

option(SMS_WEB_GAME "Build the game library in the default (all) target" OFF)
if(NOT SMS_WEB_GAME)
  set_target_properties(sms_game PROPERTIES EXCLUDE_FROM_ALL ON)
  if(TARGET sms_gx)
    set_target_properties(sms_gx PROPERTIES EXCLUDE_FROM_ALL ON)
  endif()
endif()

set(SMS_WEB_DIR ${CMAKE_CURRENT_SOURCE_DIR})
set(SMS_WEB_OUT ${CMAKE_BINARY_DIR}/site)

add_executable(sms_web_runtime
  runtime/web_main.cpp
  runtime/web_gl.cpp
  ${CMAKE_SOURCE_DIR}/platform/disc/gcdisc.cpp)
target_include_directories(sms_web_runtime PRIVATE
  ${CMAKE_SOURCE_DIR}/platform ${CMAKE_SOURCE_DIR}/platform/disc ${SMS_PORT_SRC})
target_compile_features(sms_web_runtime PRIVATE cxx_std_17)
target_compile_options(sms_web_runtime PRIVATE -Wall -Wno-unused-function)
target_link_options(sms_web_runtime PRIVATE ${SMS_WEB_LINK_FLAGS}
  -sEXPORTED_FUNCTIONS=_main,_sms_web_probe_disc
  -sWEBGL2_BACKWARDS_COMPATIBILITY_EMULATION=0)
set_target_properties(sms_web_runtime PROPERTIES
  OUTPUT_NAME sms
  SUFFIX ".js"
  RUNTIME_OUTPUT_DIRECTORY ${SMS_WEB_OUT})

# The page itself: copied beside sms.js / sms.wasm so build/web/site/ can be
# served as is (web/serve.py adds the cross-origin isolation headers). Its
# own target, run with every build, so page edits never wait for a relink.
file(GLOB SMS_WEB_SHELL CONFIGURE_DEPENDS ${SMS_WEB_DIR}/shell/*)
add_custom_target(sms_web_site ALL
  COMMAND ${CMAKE_COMMAND} -E make_directory ${SMS_WEB_OUT}
  COMMAND ${CMAKE_COMMAND} -E copy_if_different ${SMS_WEB_SHELL} ${SMS_WEB_OUT}
  COMMENT "Copying the web page into ${SMS_WEB_OUT}")
add_dependencies(sms_web_runtime sms_web_site)

# The whole game for the browser: the decompiled game (sms_game), the GX
# renderer (sms_gx) and the native platform layer (platform/**) with the
# same sources, definitions and flags as the native `sms` executable. Not in
# the default target until it runs (docs/WEB_PORT_PLAN.md, milestone 3):
#   web/build.sh sms_web_game  ->  build/web/site/sms-game.{js,wasm}
file(GLOB_RECURSE SMS_WEB_PLATFORM_SOURCES CONFIGURE_DEPENDS
  ${CMAKE_SOURCE_DIR}/platform/*.c ${CMAKE_SOURCE_DIR}/platform/*.cpp)
list(FILTER SMS_WEB_PLATFORM_SOURCES EXCLUDE REGEX "/platform/gx/")
list(FILTER SMS_WEB_PLATFORM_SOURCES EXCLUDE REGEX "/platform/mods/eclipse/")
list(FILTER SMS_WEB_PLATFORM_SOURCES EXCLUDE REGEX "/tests/")
list(FILTER SMS_WEB_PLATFORM_SOURCES EXCLUDE REGEX "/platform/trace/trace\\.cpp$")
add_executable(sms_web_game EXCLUDE_FROM_ALL
  ${SMS_PORT_SRC}/port_main.cpp ${SMS_WEB_PLATFORM_SOURCES}
  # wasm-ld has no --defsym: the DSP task's fixed address as a symbol, as on macOS.
  ${SMS_PORT_SRC}/lbl_80004600_darwin.c
  runtime/web_boot.cpp)
target_include_directories(sms_web_game PRIVATE
  ${CMAKE_SOURCE_DIR}/platform ${CMAKE_SOURCE_DIR}/platform/mods/include ${SMS_PORT_SRC}
  ${SMS_PORT_SRC}/port_include ${SMS_DECOMP_INCLUDE_DIRS})
target_compile_definitions(sms_web_game PRIVATE ${SMS_COMMON_DEFS} SMS_AUDIO_DSP_HLE=1)
target_compile_options(sms_web_game PRIVATE -fno-strict-aliasing -Wno-unused-parameter
  $<$<COMPILE_LANGUAGE:CXX>:-std=gnu++11> -sUSE_SDL=2)
target_link_libraries(sms_web_game PRIVATE
  -Wl,--whole-archive sms_game sms_gx -Wl,--no-whole-archive SDL2::SDL2)
target_link_options(sms_web_game PRIVATE ${SMS_WEB_LINK_FLAGS}
  -sGL_ENABLE_GET_PROC_ADDRESS=1 -sFULL_ES3=1 -sOFFSCREENCANVAS_SUPPORT=0
  -sOFFSCREEN_FRAMEBUFFER=1
  # Every OSThread is a pthread; workers are started ahead of time so that a
  # thread created while the page's main thread is busy does not wait for it.
  -sPTHREAD_POOL_SIZE=16
  # MEM1 lives at 0x80000000, as on the GameCube and in the native 32-bit
  # build (platform/port_runtime.cpp, map_mem1), so memory must reach past it.
  -sMAXIMUM_MEMORY=4GB
  $<$<BOOL:${SMS_WEB_ASSERTIONS}>:-sASSERTIONS=2>
  -sEXPORTED_FUNCTIONS=_main,_setenv,_malloc,_free
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,stringToNewUTF8)
add_dependencies(sms_web_game sms_web_site)
set_target_properties(sms_web_game PROPERTIES
  OUTPUT_NAME sms-game SUFFIX ".js" RUNTIME_OUTPUT_DIRECTORY ${SMS_WEB_OUT})
