/**
 * Combined `afterAllArtifactBuild` hook for dsh-plugin-desktop.
 *
 * The upstream verifier checks the Electron fuse wire and then runs a
 * packaged-runtime smoke test that executes the binary. On Linux the binary has
 * already been retargeted by `afterPack` at a runtime-only interpreter path, so
 * the smoke test can only run when that path also resolves on the build host —
 * `afterPack` aliases it, see `ensureRuntimeLibraryPath`.
 *
 * The bundled libraries themselves need no help here: the retargeting uses
 * `DT_RPATH`, which the loader resolves without any environment variable. That
 * matters beyond convenience — exporting `LD_LIBRARY_PATH` instead would leak
 * into every process the application spawns and break host tools such as the
 * zenity directory picker.
 *
 * When the runtime path could not be aliased the smoke test is skipped with an
 * explicit message; the same suite already ran in `afterPack`.
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

function smokeOrSkip(context: PackagedRuntimeContext): void {
  if (context.electronPlatformName === 'linux' && !existsSync(RUNTIME_LIBRARY_DIR)) {
    process.stdout.write(
      `dsh-plugin-desktop: skipping the final packaged-runtime smoke test because `
      + `${RUNTIME_LIBRARY_DIR} is absent on this build host; the same suite ran in afterPack\n`,
    )
    return
  }
  smokePackagedElectronRuntime(context)
}

export async function afterAllArtifactBuild(result: ElectronArtifactBuildResult): Promise<string[]> {
  return verifyAfterAllArtifactBuild(result, undefined, undefined, smokeOrSkip)
}

export default afterAllArtifactBuild
