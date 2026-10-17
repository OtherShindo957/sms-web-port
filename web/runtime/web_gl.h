// WebGL 2 context on the page's main thread, for a game running on workers.
#ifndef SMS_WEB_GL_H
#define SMS_WEB_GL_H

#ifdef __cplusplus
extern "C" {
#endif

// Creates (once) a WebGL 2 context on `canvas_selector` on the main browser
// thread, clears it, and logs the GL version and renderer. Callable from any
// thread; blocks until the main thread has done it. Returns 1 on success.
int sms_web_gl_init(const char* canvas_selector);

#ifdef __cplusplus
}
#endif

#endif
