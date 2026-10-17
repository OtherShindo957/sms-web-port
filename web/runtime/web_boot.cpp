// Browser boot for the full game (sms_web_game): called by src/port_main.cpp
// on the worker main() runs on (PROXY_TO_PTHREAD), before port_init.
//
//   - mounts the origin-private file system (OPFS) at /opfs through WasmFS:
//     the page has copied the user's disc image to /opfs/sms/disc.img, and the
//     memory card lives in /opfs/sms/card-a, so saves persist in the browser;
//   - sets browser defaults for options the player has not set (the page can
//     set any SMS_* variable before start through Module.smsEnv).
#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <pthread.h>
#include <unistd.h>

namespace {

bool mount_opfs()
{
	struct stat st;
	if (stat("/opfs", &st) == 0)
		return true;
	backend_t opfs = wasmfs_create_opfs_backend();
	if (!opfs || wasmfs_create_directory("/opfs", 0777, opfs) != 0) {
		fprintf(stderr, "[web] cannot mount OPFS at /opfs (errno %d)\n", errno);
		return false;
	}
	return true;
}

void set_default(const char* name, const char* value)
{
	if (!getenv(name))
		setenv(name, value, 0);
}

extern "C" uint32_t GXPC_FrameCount(void);        // platform/gx: the game's display copies
extern "C" unsigned long VIGetRetraceCount(void);  // platform/vi: emulated retraces

// Every 5 s, how far the game has got: the page has no picture yet, so this
// is how a hang is told from a game that is running. Only reads counters.
void* heartbeat(void*)
{
	uint32_t last = 0;
	for (int s = 5;; s += 5) {
		sleep(5);
		uint32_t frames = GXPC_FrameCount();
		fprintf(stderr, "[web] %d s: %u game frames (+%u), %lu retraces\n", s, frames, frames - last,
			VIGetRetraceCount());
		last = frames;
	}
	return nullptr;
}

} // namespace

extern "C" void port_web_boot(void)
{
	// Options from the page (Module.smsEnv = {SMS_SKIP_MOVIES: "1", ...}),
	// which only the page's main thread can see: fetched as "K=V\n..." lines.
	char* env = (char*)MAIN_THREAD_EM_ASM_INT({
		const e = Module.smsEnv || {};
		return stringToNewUTF8(Object.keys(e).map(function(k) { return k + "=" + e[k]; }).join("\n"));
	});
	for (char* line = env; line && *line;) {
		char* end = strchr(line, '\n');
		if (end)
			*end = 0;
		if (char* eq = strchr(line, '=')) {
			*eq = 0;
			setenv(line, eq + 1, 1);
		}
		line = end ? end + 1 : line + strlen(line);
	}
	free(env);
	if (mount_opfs()) {
		mkdir("/opfs/sms", 0777);
		mkdir("/opfs/sms/card-a", 0777);
		set_default("SMS_SAVE_DIR", "/opfs/sms/card-a");
		struct stat st;
		if (stat("/opfs/sms/disc.img", &st) == 0)
			set_default("SMS_DISC_IMAGE", "/opfs/sms/disc.img");
	}
	// Until the browser GX backend exists (docs/WEB_PORT_PLAN.md, milestone 3)
	// the game runs without a GL context, and without SDL audio until the
	// Web Audio path is in.
	set_default("SMS_HEADLESS", "1");
	set_default("SMS_AUDIO", "0");
	set_default("SMS_GX_GL_THREAD", "0");
	pthread_t th;
	if (pthread_create(&th, nullptr, heartbeat, nullptr) == 0)
		pthread_detach(th);
	fprintf(stderr, "[web] boot: disc %s, saves %s\n", getenv("SMS_DISC_IMAGE") ? getenv("SMS_DISC_IMAGE") : "(none)",
		getenv("SMS_SAVE_DIR") ? getenv("SMS_SAVE_DIR") : "(none)");
}
