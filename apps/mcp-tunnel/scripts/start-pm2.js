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
const args =
  action === 'start'
    ? ['startOrReload', ecosystem, '--only', 'mcp-tunnel', '--update-env']
    : ['delete', 'mcp-tunnel']
const result = spawnSync(pm2, args, {
  cwd: appRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
if (result.error && (result.error.code === 'ENOENT' || result.error.code === 'UNKNOWN')) {
  console.error('Global PM2 was not found. Install it with: npm install --global pm2')
  process.exitCode = 1
} else if (result.error) {
  console.error(`Unable to start PM2: ${result.error.message}`)
  process.exitCode = 1
} else process.exitCode = result.status ?? 1
