import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptsDirectory, '..')
const appEnvFile = path.join(projectRoot, 'apps', 'mcp-tunnel', '.env.local')
const submoduleRoot = path.join(projectRoot, 'vendor', 'ai-toolkit')
const defaultBrainRoot = path.join(submoduleRoot, 'code', 'brain')
const selectorPath = path.join(projectRoot, '.brain-source')

function run(command, args, cwd) {
  const isWindows = process.platform === 'win32'
  const executable = isWindows ? (process.env.ComSpec ?? 'cmd.exe') : command
  const commandArgs = isWindows ? ['/d', '/s', '/c', [command, ...args].join(' ')] : args
  const result = spawnSync(executable, commandArgs, { cwd, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function initializeSubmodule() {
  run(
    'git',
    [
      'submodule',
      'update',
      '--init',
      '--remote',
      '--checkout',
      '--depth',
      '1',
      '--',
      'vendor/ai-toolkit',
    ],
    projectRoot
  )
}

function loadEnvFile(filename) {
  if (!fs.existsSync(filename)) return {}
  const values = {}
  for (const line of fs.readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    values[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
  }
  return values
}

function validateBrainRoot(brainRoot) {
  const manifestPath = path.join(brainRoot, 'package.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`Brain package.json not found: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.name !== 'brain') throw new Error(`Expected a package named brain at: ${brainRoot}`)
  for (const relativePath of [
    'src/shared.ts',
    'src/public-tools.ts',
    'src/runtime/production.ts',
  ]) {
    if (!fs.existsSync(path.join(brainRoot, relativePath)))
      throw new Error(`Brain entry not found: ${path.join(brainRoot, relativePath)}`)
  }
  const sharedSource = fs.readFileSync(path.join(brainRoot, 'src', 'shared.ts'), 'utf8')
  for (const exportedName of ['createProductionBrainServices', 'registerBrainTools']) {
    if (!sharedSource.includes(exportedName))
      throw new Error(`Brain shared API does not export ${exportedName}: ${brainRoot}`)
  }
}

function selectBrainRoot(brainRoot) {
  let stat
  try {
    stat = fs.lstatSync(selectorPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink())
      throw new Error(`Refusing to replace non-link path: ${selectorPath}`)
    fs.unlinkSync(selectorPath)
  }
  fs.symlinkSync(brainRoot, selectorPath, process.platform === 'win32' ? 'junction' : 'dir')
}

const fileEnv = loadEnvFile(appEnvFile)
const configuredRoot = (fileEnv.BRAIN_SOURCE_ROOT || process.env.BRAIN_SOURCE_ROOT)?.trim()
if (configuredRoot === undefined || configuredRoot.length === 0) initializeSubmodule()
const brainRoot = path.resolve(projectRoot, configuredRoot || defaultBrainRoot)
validateBrainRoot(brainRoot)
selectBrainRoot(brainRoot)

console.log(`Using Brain source: ${brainRoot}`)
run('vp', ['install', '--frozen-lockfile'], brainRoot)
run('vp', ['run', 'stub'], brainRoot)
run('vp', ['install', '--frozen-lockfile'], projectRoot)
