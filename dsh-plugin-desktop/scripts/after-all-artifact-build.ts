/**
 * Combined `afterAllArtifactBuild` hook for dsh-plugin-desktop.
 *
 * The upstream verifier does two things per packaged context: it checks the
 * Electron fuse wire, then runs a packaged-runtime smoke test that executes the
 * binary. On Linux the binary has already been retargeted at the bundled loader
 * by `afterPack`, and that loader resolves the bundled libraries from
 * `LD_LIBRARY_PATH` — which is exactly what the shipped launcher sets at run
 * time. This wrapper supplies the same variable for the build-host smoke test so
 * the final verification still exercises the real, retargeted binary rather than
 * being skipped.
 *
 * When the runtime library path could not be aliased on the build host the smoke
 * test is skipped with an explicit message; the same suite already ran in
 * `afterPack`, before the retargeting.
 *
 * macOS and Windows keep their existing behaviour: the upstream hook is called
 * unchanged.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { PackagedRuntimeContext } from './verify-packaged-runtime.ts'
import { smokePackagedElectronRuntime } from './verify-packaged-runtime.ts'
import type { ElectronArtifactBuildResult } from './verify-electron-fuses.ts'
import { afterAllArtifactBuild as verifyAfterAllArtifactBuild } from './verify-electron-fuses.ts'
import { BUNDLED_LIBRARY_DIRNAME, INSTALLED_APP_DIR } from './patch-linux-runtime.ts'

/** Runtime library directory the packaged binary's interpreter points at. */
const RUNTIME_LIBRARY_DIR = join(INSTALLED_APP_DIR, BUNDLED_LIBRARY_DIRNAME)

function smokeWithBundledLibraries(context: PackagedRuntimeContext): void {
  if (context.electronPlatformName !== 'linux') {
    smokePackagedElectronRuntime(context)
    return
  }

  if (!existsSync(RUNTIME_LIBRARY_DIR)) {
    process.stdout.write(
      `dsh-plugin-desktop: skipping the final packaged-runtime smoke test because `
      + `${RUNTIME_LIBRARY_DIR} is absent on this build host; the same suite ran in afterPack\n`,
    )
    return
  }

  const previous = process.env.LD_LIBRARY_PATH
  process.env.LD_LIBRARY_PATH = previous === undefined || previous === ''
    ? RUNTIME_LIBRARY_DIR
    : `${RUNTIME_LIBRARY_DIR}:${previous}`

  try {
    smokePackagedElectronRuntime(context)
  } finally {
    if (previous === undefined) delete process.env.LD_LIBRARY_PATH
    else process.env.LD_LIBRARY_PATH = previous
  }
}

export async function afterAllArtifactBuild(result: ElectronArtifactBuildResult): Promise<string[]> {
  return verifyAfterAllArtifactBuild(result, undefined, undefined, smokeWithBundledLibraries)
}

export default afterAllArtifactBuild
