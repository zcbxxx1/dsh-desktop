/** Build an unsigned Linux arm64 Debian package on a native Linux arm64 host. */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronBuilderEnvironment } from './electron-builder-environment.ts'
import { prepareFsExtForElectron } from './prepare-fs-ext.ts'
import { withoutMacReleaseSecrets } from './release-preflight.ts'

/** Archived bundled-runtime library set shipped inside the Debian package. */
const LIBRARY_BUNDLE_ARCHIVE = 'build/lib-bundle.tar.gz'

/** Directory Electron Builder copies to `<app>/lib` via `extraFiles`. */
const LIBRARY_BUNDLE_DIRECTORY = 'build/lib-bundle'

/**
 * Expand the archived runtime library set beside the desktop package.
 *
 * The archive is committed instead of the extracted tree so the repository
 * carries one artifact rather than ~230 binaries; `extraFiles` then copies the
 * expanded directory into the package.
 * @param desktopRoot - Desktop workspace root.
 * @param log - Progress reporter.
 */
function expandLibraryBundle(desktopRoot: string, log: (message: string) => void): void {
  const archive = join(desktopRoot, LIBRARY_BUNDLE_ARCHIVE)
  const directory = join(desktopRoot, LIBRARY_BUNDLE_DIRECTORY)

  if (!existsSync(archive)) {
    throw new Error(
      `dsh-plugin-desktop: bundled runtime archive missing at ${LIBRARY_BUNDLE_ARCHIVE}; `
      + 'the Debian package would not carry its own glibc/GTK set',
    )
  }
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    log(`dsh-plugin-desktop: reusing expanded runtime libraries at ${LIBRARY_BUNDLE_DIRECTORY}`)
    return
  }

  mkdirSync(directory, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`tar failed to expand ${LIBRARY_BUNDLE_ARCHIVE} (exit ${String(result.status)})`)
  }
  log(
    `dsh-plugin-desktop: expanded ${LIBRARY_BUNDLE_ARCHIVE} into `
    + `${LIBRARY_BUNDLE_DIRECTORY} (${String(readdirSync(directory).length)} entries)`,
  )
}

/** Injectable native Linux packaging boundary used by focused tests. */
export interface LinuxDebPackageOptions {
  /** Environment inherited by the packaging command. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the package build. */
  readonly platform: NodeJS.Platform
  /** Node architecture executing the package build. */
  readonly arch: string
  /** Node version executing the package build. */
  readonly nodeVersion: string
  /** Repository root containing the Yarn workspace. */
  readonly workspaceRoot: string
  /** Desktop package root containing electron-builder configuration. */
  readonly desktopRoot: string
  /** Absolute electron-builder CLI module. */
  readonly builderCli: string
  /** Prepare the Electron-ABI native runtime before packaging. */
  readonly prepareRuntime: () => void
  /** Node executable used to run package-local scripts. */
  readonly nodeExecutable: string
  /** Execute one packaging command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret packaging progress. */
  readonly log: (message: string) => void
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

/** Create the native packaging options for the Debian entry point. */
export function createLinuxDebPackageOptions(): LinuxDebPackageOptions {
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workspaceRoot = resolve(desktopRoot, '..')
  const require = createRequire(import.meta.url)
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    workspaceRoot,
    desktopRoot,
    builderCli: require.resolve('electron-builder/cli.js'),
    prepareRuntime: () => {
      // fs-ext is compiled against Electron headers and must be built on the
      // target platform; the packaged runtime verifier requires the arm64 file
      // at node_modules/fs-ext/prebuilds/linux-arm64/electron.abi<ABI>.node.
      prepareFsExtForElectron({ platform: 'linux', arch: 'arm64', desktopRoot })
    },
    nodeExecutable: process.execPath,
    run,
    log: message => console.log(message),
  }
}

/** Run the shared host and Node release gates before packaging. */
function assertLinuxDebHost(options: LinuxDebPackageOptions): void {
  if (options.platform !== 'linux') {
    throw new Error('Linux Debian package must be built on a native Linux host')
  }
  if (options.arch !== 'arm64') {
    throw new Error(`Linux Debian package requires arm64 Node; received ${options.arch}`)
  }
  const versionMatch = /^(\d+)\.(\d+)\./u.exec(options.nodeVersion)
  const major = Number(versionMatch?.[1])
  const minor = Number(versionMatch?.[2])
  if (!((major === 22 && minor >= 19) || major === 24)) {
    throw new Error(
      `Linux Debian package requires Node 22.19+ or Node 24.x with bundled Corepack; received ${options.nodeVersion}`,
    )
  }
}

/**
 * Run the gates and package one unsigned arm64 Debian artifact.
 *
 * The signed and notarized platforms keep their credentialed release flow; this
 * entry point produces an unsigned, installable arm64 `.deb` for local Linux
 * hosts. The packaged-runtime and Electron-fuse verifiers configured in
 * `package.json` run inside Electron Builder as the `afterPack` and
 * `afterAllArtifactBuild` hooks.
 * @param options - Injectable process and command boundaries.
 */
export function packageLinuxDeb(
  options: LinuxDebPackageOptions = createLinuxDebPackageOptions(),
): void {
  assertLinuxDebHost(options)

  const cleanEnvironment = withoutMacReleaseSecrets(options.env)
  options.log('Building an unsigned Linux arm64 Debian package; signing is not applicable.')
  expandLibraryBundle(options.desktopRoot, options.log)
  options.prepareRuntime()
  options.run(
    options.nodeExecutable,
    [
      options.builderCli,
      '--linux',
      'deb',
      '--arm64',
      '--publish',
      'never',
      '--config.npmRebuild=false',
    ],
    options.desktopRoot,
    electronBuilderEnvironment({
      ...cleanEnvironment,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    }),
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    packageLinuxDeb()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
