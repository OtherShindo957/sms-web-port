/* Browser build only (force-included into every game unit by CMakeLists.txt).
 *
 * The game defines the global operator new/delete on top of JKRHeap. Native
 * builds rename those definitions, and every game reference to them, in
 * libsms_game.a with `objcopy --redefine-syms`, so only game code allocates
 * from JKR heaps while libc++ and platform/ use the host allocator.
 * llvm-objcopy cannot rename symbols in wasm objects, so the browser build
 * gives the same four functions the same four names at compile time: an asm
 * label on a declaration seen before any use applies to the definition in
 * JKRHeap.cpp, to every new/delete expression and to deleting destructors. */
#ifndef PORT_WEB_NEW_H
#define PORT_WEB_NEW_H
#ifdef __cplusplus
#include <stddef.h>
void* operator new(size_t) __asm__("__sms_game_new");
void* operator new[](size_t) __asm__("__sms_game_new_array");
void operator delete(void*) throw() __asm__("__sms_game_delete");
void operator delete[](void*) throw() __asm__("__sms_game_delete_array");
#endif
#endif
