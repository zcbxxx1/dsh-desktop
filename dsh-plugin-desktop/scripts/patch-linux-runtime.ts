/**
 * Retarget the packaged Linux executable at the bundled runtime libraries.
 *
 * Why this exists
 * ---------------
 * The Linux arm64 package ships a self-contained library set (`<app>/lib`,
 * extracted from Ubuntu 22.04) plus its own dynamic loader. Electron 43 is
 * built for glibc 2.35+ / GLib 2.72+ / GTK 3.24.33+; distributions such as
 * Kylin V10 SP1 ship glibc 2.31 / GLib 2.64 / GTK 3.24.23 and the stock binary
 * dies with SIGSEGV during startup.
 *
 * Replacing the system glibc is not an option, so the package carries its own
 * loader and library set. Two things must be rewritten in the packaged binary:
 *
 *   1. `PT_INTERP` — the kernel must load `<app>/lib/ld-linux-aarch64.so.1`
 *      instead of `/lib/ld-linux-aarch64.so.1`. Only the interpreter decides
 *      which libc is in play; `LD_LIBRARY_PATH` cannot change that.
 *   2. Nothing else. The bundled loader resolves the bundled libraries from
 *      `LD_LIBRARY_PATH`, which the shipped launcher sets.
 *
 * Why not `DT_RUNPATH` / `$ORIGIN`
 * --------------------------------
 * Setting `$ORIGIN:$ORIGIN/lib` on the binary was tried first and does not
 * work here: the loader never consults it and falls through to the host cache.
 * `LD_LIBRARY_PATH` is the mechanism that is verified to work, so the package
 * ships a launcher that sets it.
 *
 * Ordering constraint
 * -------------------
 * This runs AFTER the upstream packaged-runtime verifier. That verifier
 * executes the packaged binary for its smoke tests, which cannot work once
 * `PT_INTERP` points at a runtime-only path. Patching afterwards leaves the
 * shipped binary patched while the verification still exercises a runnable one.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { PackagedRuntimeContext } from './verify-packaged-runtime.ts'
import { resolvePackagedExecutablePath } from './verify-packaged-runtime.ts'

/** Installed application directory, as declared by the Linux build config. */
export const INSTALLED_APP_DIR = '/opt/DSH Desktop'

/** Directory name holding the bundled loader and libraries inside the app. */
export const BUNDLED_LIBRARY_DIRNAME = 'lib'

/** Name of the shell launcher that supplies LD_LIBRARY_PATH. */
export const LAUNCHER_FILENAME = 'dsh-desktop-launch'

/**
 * Make the runtime library path resolvable on the build host.
 *
 * `PT_INTERP` is an absolute path, so once the packaged binary points at
 * `/opt/DSH Desktop/lib/ld-linux-aarch64.so.1` the remaining build steps cannot
 * execute it unless that path also exists here. Electron Builder's
 * `afterAllArtifactBuild` hook re-runs the packaged-runtime smoke test, so this
 * alias is what lets that final verification still exercise the real binary.
 *
 * The alias is a symlink to the freshly packed library directory. On a clean CI
 * runner nothing exists under `/opt/DSH Desktop` yet; on a host where the
 * package is already installed only the `lib` entry is added.
 * @param appOutDir - Packed application directory.
 * @param log - Progress reporter.
 * @returns True when the runtime path resolves.
 */
export function ensureRuntimeLibraryPath(appOutDir: string, log: (message: string) => void): boolean {
  const runtimeLibDir = join(INSTALLED_APP_DIR, BUNDLED_LIBRARY_DIRNAME)
  const packedLibDir = join(appOutDir, BUNDLED_LIBRARY_DIRNAME)

  if (existsSync(runtimeLibDir)) {
    log(`dsh-plugin-desktop: runtime library path already present at ${runtimeLibDir}`)
    return true
  }

  const mkdirPlain = spawnSync('mkdir', ['-p', INSTALLED_APP_DIR], { stdio: 'ignore' })
  if (mkdirPlain.status !== 0 && !existsSync(INSTALLED_APP_DIR)) {
    spawnSync('sudo', ['-n', 'mkdir', '-p', INSTALLED_APP_DIR], { stdio: 'ignore' })
  }
  if (!existsSync(INSTALLED_APP_DIR)) {
    log(
      `dsh-plugin-desktop: could not create ${INSTALLED_APP_DIR}; the final packaged-runtime `
      + 'smoke test will be skipped (it already ran in afterPack)',
    )
    return false
  }

  try {
    symlinkSync(packedLibDir, runtimeLibDir)
    log(`dsh-plugin-desktop: aliased ${runtimeLibDir} -> ${packedLibDir}`)
    return true
  } catch {
    const elevated = spawnSync('sudo', ['-n', 'ln', '-sfn', packedLibDir, runtimeLibDir], { stdio: 'ignore' })
    if (elevated.status === 0) {
      log(`dsh-plugin-desktop: aliased ${runtimeLibDir} -> ${packedLibDir} (elevated)`)
      return true
    }
  }

  log(
    `dsh-plugin-desktop: could not alias ${runtimeLibDir}; the final packaged-runtime `
    + 'smoke test will be skipped (it already ran in afterPack)',
  )
  return false
}

/** Injectable process boundary used by focused tests. */
export interface LinuxRuntimePatchOptions {
  /** Directory holding the unpacked application, as produced by Electron Builder. */
  readonly appOutDir: string
  /** Absolute path of the packaged executable to rewrite. */
  readonly executable: string
  /** Directory inside the package that holds the bundled loader and libraries. */
  readonly bundledLibraryDir: string
  /** Absolute interpreter path the packaged binary must reference at runtime. */
  readonly interpreter: string
  /** `patchelf` invocation boundary. */
  readonly runPatchelf: (args: readonly string[]) => void
  /** Report non-secret progress. */
  readonly log: (message: string) => void
}

function runPatchelf(args: readonly string[]): void {
  const result = spawnSync('patchelf', args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`patchelf ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/**
 * Rewrite `PT_INTERP` so the packaged executable loads the bundled loader.
 *
 * The interpreter path is the runtime location (`/opt/DSH Desktop/lib/...`),
 * not the build directory: it is baked into the ELF header and only resolved
 * when the installed application starts.
 * @param options - Injectable process and path boundaries.
 */
export function patchLinuxRuntime(options: LinuxRuntimePatchOptions): void {
  const { executable, interpreter, bundledLibraryDir, runPatchelf: run, log } = options

  if (!existsSync(executable)) {
    throw new Error(`dsh-plugin-desktop: packaged executable missing at ${executable}`)
  }
  if (!existsSync(join(bundledLibraryDir, 'ld-linux-aarch64.so.1'))) {
    throw new Error(
      `dsh-plugin-desktop: bundled loader missing at ${bundledLibraryDir}/ld-linux-aarch64.so.1`,
    )
  }

  // Two rewrites, both on the executable only:
  //
  //   * PT_INTERP selects the loader, and therefore the libc.
  //   * DT_RPATH (not DT_RUNPATH) resolves the bundled libraries. RPATH is
  //     searched transitively for the whole dependency chain, so the bundled
  //     libraries find each other without any of them being rewritten, and it
  //     keeps working without LD_LIBRARY_PATH.
  //
  // Using LD_LIBRARY_PATH instead was tried and rejected: the variable is
  // inherited by every process the application spawns, so host tools it shells
  // out to — the zenity directory picker in particular — loaded the bundled
  // glibc/GTK and died with SIGSEGV.
  //
  // `--force-rpath` matters: plain `--set-rpath` writes DT_RUNPATH, which is
  // not transitive and is not consulted the same way here.
  const rpath = '$ORIGIN:$ORIGIN/lib'
  run(['--force-rpath', '--set-rpath', rpath, '--set-interpreter', interpreter, executable])
  log(`dsh-plugin-desktop: retargeted ${executable} (interpreter ${interpreter}, rpath ${rpath})`)

  // The crash handler is exec'd by the main process and needs the same loader;
  // without it every crash-report spawn fails with a missing-interpreter error.
  const crashpad = join(options.appOutDir, 'chrome_crashpad_handler')
  if (existsSync(crashpad)) {
    try {
      renameSync(crashpad, `${crashpad}.orig`)
      run(['--force-rpath', '--set-rpath', rpath, '--set-interpreter', interpreter, `${crashpad}.orig`])
      renameSync(`${crashpad}.orig`, crashpad)
      log('dsh-plugin-desktop: retargeted chrome_crashpad_handler')
    } catch (error) {
      log(`dsh-plugin-desktop: chrome_crashpad_handler left unpatched (${String(error)})`)
    }
  }
}

/** Electron Builder afterPack entry point for the Linux retargeting step. */
export function patchPackagedLinuxRuntime(context: PackagedRuntimeContext): void {
  const appOutDir = context.appOutDir
  patchLinuxRuntime({
    appOutDir,
    executable: resolvePackagedExecutablePath(context),
    bundledLibraryDir: join(appOutDir, BUNDLED_LIBRARY_DIRNAME),
    interpreter: join(INSTALLED_APP_DIR, BUNDLED_LIBRARY_DIRNAME, 'ld-linux-aarch64.so.1'),
    runPatchelf,
    log: message => process.stdout.write(`${message}\n`),
  })

  ensureRuntimeLibraryPath(appOutDir, message => process.stdout.write(`${message}\n`))
}
