/**
 * Combined `afterPack` hook for dsh-plugin-desktop.
 *
 * Order matters:
 *
 *   1. Run the upstream packaged-runtime verifier. Its smoke tests execute the
 *      packaged binary directly, which only works while `PT_INTERP` still points
 *      at a loader that exists on the build host.
 *   2. On Linux, retarget `PT_INTERP` at the bundled loader shipped in
 *      `<app>/lib`. This is deliberately last: the interpreter path is a
 *      runtime path that does not exist on the build host, so doing it first
 *      would make every smoke test fail with a missing-interpreter error.
 *
 * Electron Builder assembles the Debian package after this hook returns, so the
 * artifact still receives the retargeted binary.
 *
 * macOS and Windows keep their existing behaviour — the verifier runs and no
 * retargeting happens.
 */

import type { PackagedRuntimeContext } from './verify-packaged-runtime.ts'
import { afterPack as verifyAfterPack } from './verify-packaged-runtime.ts'
import { patchPackagedLinuxRuntime } from './patch-linux-runtime.ts'

export async function afterPack(context: PackagedRuntimeContext): Promise<void> {
  await verifyAfterPack(context)

  if (context.electronPlatformName !== 'linux') return

  try {
    patchPackagedLinuxRuntime(context)
  } catch (error) {
    process.stdout.write(
      `dsh-plugin-desktop: failed to retarget the packaged Linux runtime: ${String(error)}\n`,
    )
    throw error
  }
}

export default afterPack
