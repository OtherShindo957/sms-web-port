// WebGL 2 on the page's main thread.
//
// The game runs on workers (its OSThreads are pthreads), but the canvas stays
// on the main thread: platform/gx already funnels every GL call through one
// queue drained by a "GL thread" (gx_glthread.h), and in the browser that
// consumer becomes the main thread. This file is the first piece: creating the
// context there from a worker and proving it renders.
#include "web_gl.h"

#include <GLES3/gl3.h>
#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/threading.h>
#include <stdio.h>

namespace {

EMSCRIPTEN_WEBGL_CONTEXT_HANDLE g_ctx;

int init_on_main(const char* selector)
{
	if (g_ctx)
		return 1;
	EmscriptenWebGLContextAttributes attr;
	emscripten_webgl_init_context_attributes(&attr);
	attr.majorVersion = 2;
	attr.minorVersion = 0;
	attr.alpha = false;
	attr.depth = true;
	attr.stencil = false;
	attr.antialias = false;
	attr.preserveDrawingBuffer = false;
	attr.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context(selector, &attr);
	if (ctx <= 0) {
		printf("[web] FAIL: no WebGL 2 context on %s (error %ld)\n", selector, (long)ctx);
		return 0;
	}
	emscripten_webgl_make_context_current(ctx);
	g_ctx = ctx;
	// The GameCube's EFB is 640x528; the frontend scales the canvas with CSS.
	emscripten_set_canvas_element_size(selector, 640, 528);
	glViewport(0, 0, 640, 528);
	glClearColor(0.05f, 0.35f, 0.75f, 1.0f); // "Sunshine" blue: proves the context presents
	glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
	printf("[web] WebGL: %s | %s | GLSL %s\n", (const char*)glGetString(GL_VERSION),
		(const char*)glGetString(GL_RENDERER), (const char*)glGetString(GL_SHADING_LANGUAGE_VERSION));
	int maxTex = 0, maxSamples = 0;
	glGetIntegerv(GL_MAX_TEXTURE_SIZE, &maxTex);
	glGetIntegerv(GL_MAX_SAMPLES, &maxSamples);
	printf("[web] WebGL limits: max texture %d, max samples %d, float color buffer %s\n", maxTex, maxSamples,
		emscripten_webgl_enable_extension(ctx, "EXT_color_buffer_float") ? "yes" : "no");
	return 1;
}

} // namespace

extern "C" int sms_web_gl_init(const char* selector)
{
	if (emscripten_is_main_browser_thread())
		return init_on_main(selector);
	return emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_II, init_on_main, selector);
}
