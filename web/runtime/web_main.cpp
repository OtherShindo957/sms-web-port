// Browser runtime entry point (docs/WEB_PORT_PLAN.md, milestones 1-2).
//
// main() runs on a worker (PROXY_TO_PTHREAD), where blocking is allowed, as
// the game's own boot thread will. It:
//   1. mounts the origin-private file system (OPFS) at /opfs through WasmFS;
//      the page has already copied the user's disc image there (shell/app.js),
//   2. opens that image with the port's own reader (platform/disc) and checks
//      that it is Super Mario Sunshine (GMSE01) with a readable FST and files,
//   3. creates the WebGL 2 context on the page's main thread (web_gl.cpp),
//      where the GX layer's GL queue will run.
// Every step reports its real result on stdout ("[web] ..."), which the page
// shows; a failure is reported as such and main() returns non-zero.
#include <emscripten.h>
#include <emscripten/wasmfs.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "gcdisc.h"
#include "web_gl.h"

namespace {

const char* kOpfsRoot = "/opfs";
const char* kDiscPath = "/opfs/sms/disc.img";

bool mount_opfs()
{
	struct stat st;
	if (stat(kOpfsRoot, &st) == 0)
		return true;
	backend_t opfs = wasmfs_create_opfs_backend();
	if (!opfs) {
		printf("[web] FAIL: cannot create the OPFS backend\n");
		return false;
	}
	if (wasmfs_create_directory(kOpfsRoot, 0777, opfs) != 0) {
		printf("[web] FAIL: cannot mount OPFS at %s (errno %d)\n", kOpfsRoot, errno);
		return false;
	}
	printf("[web] OPFS mounted at %s\n", kOpfsRoot);
	return true;
}

uint32_t be32(const uint8_t* p) { return (uint32_t)p[0] << 24 | (uint32_t)p[1] << 16 | (uint32_t)p[2] << 8 | p[3]; }

} // namespace

// Opens the image at `path` and checks it file by file; 0 when it is a usable
// GMSE01 disc. Exported so the page can re-check an image without a reload.
extern "C" EMSCRIPTEN_KEEPALIVE int sms_web_probe_disc(const char* path)
{
	GCDisc* d = gcdisc_open(path, 1);
	if (!d) {
		printf("[web] FAIL: %s is not a readable GameCube disc image\n", path);
		return 1;
	}
	const char* id = gcdisc_game_id(d);
	printf("[web] disc: id %s, %.1f MiB, %u FST entries, title \"%.64s\"\n", id,
		gcdisc_size(d) / 1048576.0, gcdisc_entry_count(d), (const char*)gcdisc_header(d) + 0x20);
	int rc = 0;
	if (strcmp(id, "GMSE01") != 0) {
		printf("[web] FAIL: game id %s; this port needs Super Mario Sunshine (North America, GMSE01)\n", id);
		rc = 1;
	} else if (gcdisc_header(d)[7] != 0) {
		printf("[web] FAIL: disc revision %u; this port needs Rev 0\n", gcdisc_header(d)[7]);
		rc = 1;
	}
	// Read the start of files the boot path needs and check their magic, so a
	// truncated or corrupt copy is caught here and not deep inside the game.
	struct {
		const char* path;
		const char* magic;
	} checks[] = {
		{"/data/nintendo.szs", "Yaz0"},
		{"/data/mario.szs", "Yaz0"},
		{"/data/scene/dolpic0.szs", "Yaz0"},
	};
	for (auto& c : checks) {
		int32_t e = gcdisc_lookup(d, c.path);
		uint8_t head[16] = {0};
		GCDiscEntry info;
		if (e < 0 || !gcdisc_entry(d, e, &info)) {
			printf("[web] FAIL: %s missing from the FST\n", c.path);
			rc = 1;
			continue;
		}
		uint32_t n = gcdisc_read_file(d, e, 0, head, sizeof head);
		bool ok = n == sizeof head && memcmp(head, c.magic, 4) == 0;
		// The last byte of the file proves the copy is complete.
		uint8_t last = 0;
		bool tail = info.size && gcdisc_read_file(d, e, info.size - 1, &last, 1) == 1;
		printf("[web] %s %s: %u bytes, magic %.4s, decompressed %u, tail %s\n", ok && tail ? "ok" : "FAIL",
			c.path, info.size, (const char*)head, be32(head + 4), tail ? "readable" : "unreadable");
		if (!ok || !tail)
			rc = 1;
	}
	uint32_t dol_off = 0, dol_size = 0;
	if (gcdisc_system_file(d, GCDISC_DOL, &dol_off, &dol_size))
		printf("[web] main.dol at 0x%x, %u bytes\n", dol_off, dol_size);
	gcdisc_close(d);
	return rc;
}

int main(int argc, char** argv)
{
	printf("[web] runtime started (wasm32, pointer size %zu, long %zu, long long align %zu)\n", sizeof(void*),
		sizeof(long), alignof(long long));
	int rc = 0;
	if (!mount_opfs())
		return 2;
	const char* disc = argc > 1 ? argv[1] : kDiscPath;
	struct stat st;
	if (stat(disc, &st) != 0) {
		printf("[web] no disc image at %s (import one first)\n", disc);
		rc = 3;
	} else {
		printf("[web] disc image %s: %lld bytes\n", disc, (long long)st.st_size);
		rc = sms_web_probe_disc(disc);
	}
	if (!sms_web_gl_init("#canvas"))
		rc = rc ? rc : 4;
	printf("[web] runtime check %s (code %d)\n", rc ? "FAILED" : "passed", rc);
	EM_ASM({ if (Module.onRuntimeCheck) Module.onRuntimeCheck($0); }, rc);
	return rc;
}
