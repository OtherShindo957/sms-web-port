// Desktop GL entry points that need adaptation for the WebGL 2 backend.
// All real GL calls use Emscripten's context proxy; this code runs on the
// game worker, never on a second native GL thread.
#include <GLES3/gl3.h>
#include <webgl/webgl2.h>
#include <emscripten/html5_webgl.h>
#include <emscripten/threading.h>
#include <cassert>
#include <cstring>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" void emscripten_glDrawElements(GLenum, GLsizei, GLenum, const void*);
extern "C" void emscripten_glGetBufferSubData(GLenum, GLintptr, GLsizeiptr, void*);

namespace {
// Emscripten proxies glDrawElements synchronously (the indices might be
// client memory the call must read before returning), so each draw waited for
// the main thread to run everything queued before it. Every element draw here
// reads its indices from the bound element buffer (flushBatch rebases them
// into it), so the draw is queued like the state calls around it.
void drawElements(GLenum mode, GLsizei count, GLenum type, const void* indices) {
    emscripten_async_run_in_main_runtime_thread(EM_FUNC_SIG_VIIII, &emscripten_glDrawElements, mode, count, type,
                                                indices);
}
void clearDepth(double d) { glClearDepthf(float(d)); }
void depthRange(double a, double b) { glDepthRangef(float(a), float(b)); }
void bindFrag(GLuint, GLuint, const char*) {} // every shader has one colour output
void pointSize(GLfloat) {} // WebGL point size is written by the vertex shader
void logicOp(GLenum) {} // COPY is the game's usual logic operation; other ops remain unsupported
bool desktopCap(GLenum c) { return c == 0x0BF2 || (c >= 0x3000 && c < 0x3008) || c == 0x8642; }
void enable(GLenum c) { if (!desktopCap(c)) glEnable(c); }
void disable(GLenum c) { if (!desktopCap(c)) glDisable(c); }
GLboolean isEnabled(GLenum c) { return desktopCap(c) ? GL_FALSE : glIsEnabled(c); }
void drawBase(GLenum mode, GLsizei count, GLenum type, const void* indices, GLint base) {
    assert(base == 0); // rebased in flushBatch
    drawElements(mode, count, type, indices);
}
void multiBase(GLenum mode, const GLsizei* count, GLenum type, const void* const* indices,
               GLsizei n, const GLint* base) {
    for (GLsizei i = 0; i < n; ++i) drawBase(mode, count[i], type, indices[i], base[i]);
}
GLenum waitSync(GLsync sync, GLbitfield flags, GLuint64) {
    // WebGL permits only a zero timeout. BufferSubData and getBufferSubData
    // provide ordering for writes/reads without a CPU busy-wait on the browser.
    return glClientWaitSync(sync, flags, 0);
}
// glMapBufferRange in CPU memory. Mappings belong to buffers, not targets:
// the peek snapshots keep a colour and a depth pixel buffer mapped at once.
struct Mapping { std::vector<unsigned char> data; GLintptr offset; GLbitfield access; };
std::unordered_map<GLuint, Mapping> maps;
std::unordered_map<GLenum, GLuint> bound;  // what bindBuffer last bound to each target
void bindBuffer(GLenum target, GLuint buffer) {
    bound[target] = buffer;
    glBindBuffer(target, buffer);
}
void* mapBuffer(GLenum target, GLintptr offset, GLsizeiptr length, GLbitfield access) {
    auto& m = maps[bound[target]];
    m.data.resize(size_t(length)); m.offset = offset; m.access = access;
    // Emscripten does not proxy glGetBufferSubData: on this worker it would
    // call a WebGL context that does not exist here. Run it where it does.
    if (access & GL_MAP_READ_BIT)
        emscripten_sync_run_in_main_runtime_thread(EM_FUNC_SIG_VIIII, &emscripten_glGetBufferSubData, target, offset,
                                                   length, m.data.data());
    return m.data.data();
}
GLboolean unmapBuffer(GLenum target) {
    auto it = maps.find(bound[target]);
    if (it == maps.end()) return GL_FALSE;
    auto& m = it->second;
    if (m.access & GL_MAP_WRITE_BIT) glBufferSubData(target, m.offset, m.data.size(), m.data.data());
    maps.erase(it);
    return GL_TRUE;
}
void replaceAll(std::string& s, const std::string& from, const std::string& to) {
    for (size_t at = 0; (at = s.find(from, at)) != std::string::npos; at += to.size()) s.replace(at, from.size(), to);
}
void shaderSource(GLuint shader, GLsizei count, const GLchar* const* strings, const GLint* lengths) {
    std::string s;
    for (GLsizei i = 0; i < count; ++i) s.append(strings[i], lengths && lengths[i] >= 0 ? size_t(lengths[i]) : strlen(strings[i]));
    replaceAll(s, "#version 330 core", "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;");
    // ES 3 has no user clip planes. Interpolate the two GX plane distances
    // and discard clipped fragments (the hardware still clips the viewport).
    if (s.find("gl_ClipDistance") != std::string::npos) {
        replaceAll(s, "gl_ClipDistance", "sms_clip");
        s.insert(s.find("void main"), "out highp vec2 sms_clip;\n");
    } else if (s.find("uniform sampler2D u_tex[8]") != std::string::npos) {
        s.insert(s.find("void main"), "in highp vec2 sms_clip;\n");
        const size_t body = s.find('{', s.find("void main"));
        s.insert(body + 1, "\nif (any(lessThan(sms_clip, vec2(0.0)))) discard;\n");
    }
    const char* text = s.c_str();
    glShaderSource(shader, 1, &text, nullptr);
}
}

void* sms_web_get_proc(const char* name) {
#define PROC(glname, fn) if (!strcmp(name, #glname)) return reinterpret_cast<void*>(&fn)
    PROC(glClearDepth, clearDepth); PROC(glDepthRange, depthRange);
    PROC(glBindFragDataLocation, bindFrag); PROC(glPointSize, pointSize); PROC(glLogicOp, logicOp);
    PROC(glEnable, enable); PROC(glDisable, disable); PROC(glIsEnabled, isEnabled);
    PROC(glDrawElementsBaseVertex, drawBase); PROC(glMultiDrawElementsBaseVertex, multiBase);
    PROC(glClientWaitSync, waitSync); PROC(glMapBufferRange, mapBuffer); PROC(glUnmapBuffer, unmapBuffer);
    PROC(glBindBuffer, bindBuffer);
    PROC(glShaderSource, shaderSource); PROC(glDrawElements, drawElements);
#undef PROC
    if (!strcmp(name, "glBufferStorage") || !strcmp(name, "glGetProgramBinary") ||
        !strcmp(name, "glProgramBinary") || !strcmp(name, "glProgramParameteri") ||
        !strcmp(name, "glMaxShaderCompilerThreadsKHR")) return nullptr;
    return emscripten_webgl_get_proc_address(name);
}
