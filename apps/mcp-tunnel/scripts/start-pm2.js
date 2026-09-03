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
    shell: process.platform === 'win32',
    encoding: 'utf8',
  })
}

function ensureLogRotation() {
  const modules = runPm2(['module:list'], { capture: true })
  if (modules.error) throw modules.error
  const moduleOutput = `${modules.stdout ?? ''}\n${modules.stderr ?? ''}`
  if (!/pm2-logrotate\b/.test(moduleOutput)) {
    const installed = runPm2(['install', 'pm2-logrotate'])
    if (installed.status !== 0)
      throw new Error('Unable to install PM2 log rotation module (pm2-logrotate)')
  }
  const settings = [
    ['max_size', '10M'],
    ['retain', '7'],
    ['compress', 'true'],
    ['workerInterval', '3600'],
    ['rotateInterval', '0 0 * * *'],
  ]
  for (const [key, value] of settings) {
    const configured = runPm2(['set', `pm2-logrotate:${key}`, value])
    if (configured.status !== 0)
      throw new Error(`Unable to configure PM2 log rotation setting: ${key}`)
  }
}

const args =
  action === 'start'
    ? ['startOrReload', ecosystem, '--only', 'mcp-tunnel', '--update-env']
    : ['delete', 'mcp-tunnel']
let result
try {
  if (action === 'start') ensureLogRotation()
  result = runPm2(args)
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
