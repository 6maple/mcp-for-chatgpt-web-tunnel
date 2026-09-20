import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const ecosystem = path.join(scriptsDirectory, 'ecosystem.config.cjs')
const pm2 = 'pm2'
const action = process.argv[2] ?? 'start'
if (!['start', 'stop'].includes(action)) {
  console.error(`Unknown PM2 action: ${action}. Expected start or stop.`)
  process.exitCode = 1
  process.exit()
}
const appRoot = fs.existsSync(path.join(scriptsDirectory, 'assets', 'windows-toast.ps1'))
  ? scriptsDirectory
  : path.resolve(scriptsDirectory, '..')

function runPm2(args, options = {}) {
  return spawnSync(pm2, args, {
    cwd: appRoot,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  })
}

function getPm2Processes() {
  const result = runPm2(['jlist'], { capture: true })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Unable to query PM2 processes: ${result.stderr?.trim() || 'unknown error'}`)
  }

  try {
    return JSON.parse(result.stdout ?? '[]')
  } catch {
    throw new Error('Unable to parse PM2 process list')
  }
}

function findLogRotationModule(processes) {
  return processes.find(
    (process) => process.name === 'pm2-logrotate' && process.pm2_env?.pmx_module === true
  )
}

function isProcessOnline(processes, name) {
  return processes.some((process) => process.name === name && process.pm2_env?.status === 'online')
}

function ensureLogRotation(processes) {
  let logRotation = findLogRotationModule(processes)
  if (!logRotation) {
    const installed = runPm2(['install', 'pm2-logrotate'])
    if (installed.status !== 0)
      throw new Error('Unable to install PM2 log rotation module (pm2-logrotate)')
    processes = getPm2Processes()
    logRotation = findLogRotationModule(processes)
    if (!logRotation) throw new Error('PM2 log rotation module did not start after installation')
  }

  const settings = [
    ['max_size', '10M'],
    ['retain', '7'],
    ['compress', 'true'],
    ['workerInterval', '3600'],
    ['rotateInterval', '0 0 * * *'],
  ]
  for (const [key, value] of settings) {
    if (String(logRotation.pm2_env?.[key] ?? '') === value) continue

    const configured = runPm2(['set', `pm2-logrotate:${key}`, value])
    if (configured.status !== 0)
      throw new Error(`Unable to configure PM2 log rotation setting: ${key}`)
  }

  return processes
}

const args =
  action === 'start'
    ? ['startOrReload', ecosystem, '--only', 'mcp-tunnel', '--update-env']
    : ['delete', 'mcp-tunnel']
let result
try {
  if (action === 'start') {
    const processes = ensureLogRotation(getPm2Processes())
    if (isProcessOnline(processes, 'mcp-tunnel')) {
      console.log('[PM2] App [mcp-tunnel] is already online')
      result = { status: 0 }
    } else result = runPm2(args)
  } else result = runPm2(args)
} catch (error) {
  console.error(
    `Unable to configure PM2: ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
  process.exit()
}
if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'UNKNOWN')) {
  console.error('Global PM2 was not found. Install it with: npm install --global pm2')
  process.exitCode = 1
} else if (result.error) {
  console.error(`Unable to start PM2: ${result.error.message}`)
  process.exitCode = 1
} else process.exitCode = result.status ?? 1
