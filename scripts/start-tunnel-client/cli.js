import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(root, '..', '..')
const envFile = path.join(root, '..', '..', '.env.local')

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

const child = spawn(
  path.join(root, 'tunnel-client.exe'),
  ['run', '--config', path.join(root, 'tunnel-client.yaml')],
  {
    cwd: root,
    env: {
      ...process.env,
      ...loadEnvFile(envFile),
      MCP_WORKSPACE_ROOT: workspaceRoot,
    },
    stdio: 'inherit',
    windowsHide: false,
  }
)

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (!child.killed) child.kill(signal)
  })
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
child.on('error', (error) => {
  console.error(`无法启动 tunnel-client: ${error.message}`)
  process.exitCode = 1
})
