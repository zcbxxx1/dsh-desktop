/*
 * Compatibility shim for vendor-patched glibc builds.
 *
 * Why this exists
 * ---------------
 * The package bundles a stock Ubuntu 22.04 runtime (glibc 2.35) so the
 * application can start on hosts whose system libraries predate Electron 43's
 * baseline. Some vendors patch their *own* glibc with extra symbols that their
 * Mesa/GLX and Vulkan drivers link against. Kylin V10 SP1 is one of them: its
 * `libc-2.31.so` exports `mesa_memcpy`, `mesa_memmove` and `mesa_memset`, none
 * of which upstream glibc provides.
 *
 * Under the bundled stock glibc those libraries therefore fail to resolve, and
 * anything that loads them — Chromium's GPU process in particular — dies with
 * `symbol lookup error: ... undefined symbol: mesa_memcpy, version GLIBC_2.17`
 * in a restart loop.
 *
 * Enumerating the gap
 * -------------------
 *     nm -D --defined-only /lib/<arch>-linux-gnu/libc.so.6 | awk '{print $3}' | sort -u > sys.txt
 *     nm -D --defined-only <bundle>/libc.so.6           | awk '{print $3}' | sort -u > bundled.txt
 *     comm -23 sys.txt bundled.txt        # symbols only the vendor glibc has
 *     # then intersect with the undefined symbols of the host's GL/EGL/Vulkan
 *     # libraries (libGL, libGLX, libEGL, libvulkan_*)
 *
 * The three names map one-to-one onto the standard routines, so they are
 * re-exported as thin wrappers. They are published under the GLIBC_2.17 version
 * tag because that is what the referencing libraries expect; see the version
 * script alongside this file.
 *
 * Loaded through LD_PRELOAD by the launcher. The names are vendor-specific and
 * do not collide with anything upstream, so preloading is inert on hosts that
 * do not need it.
 */

#include <stddef.h>
#include <string.h>

void *mesa_memcpy(void *destination, const void *source, size_t count) {
  return memcpy(destination, source, count);
}

void *mesa_memmove(void *destination, const void *source, size_t count) {
  return memmove(destination, source, count);
}

void *mesa_memset(void *destination, int value, size_t count) {
  return memset(destination, value, count);
}
