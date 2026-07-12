import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = process.cwd()
const envFile = path.join(cwd, '.env.local')
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const configFile = path.join(scriptDirectory, 'tunnel-client.yaml')

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

const fileEnv = loadEnvFile(envFile)
const configuredPath = fileEnv.TUNNEL_CLIENT_PATH || process.env.TUNNEL_CLIENT_PATH
const executable = configuredPath ? path.resolve(cwd, configuredPath) : path.join(cwd, 'tunnel-client.exe')
const workspaceRoot = path.resolve(cwd, fileEnv.MCP_WORKSPACE_ROOT || process.env.MCP_WORKSPACE_ROOT || cwd)

if (!fs.existsSync(executable)) {
  console.error(`Unable to find tunnel-client.exe: ${executable}`)
  console.error('Place tunnel-client.exe in the current directory or set TUNNEL_CLIENT_PATH in .env.local.')
  process.exitCode = 1
} else if (!fs.existsSync(configFile)) {
  console.error(`Unable to find tunnel-client config: ${configFile}`)
  process.exitCode = 1
} else {
  const child = spawn(executable, ['run', '--config', configFile], {
    cwd,
    env: { ...process.env, ...fileEnv, MCP_WORKSPACE_ROOT: workspaceRoot },
    stdio: 'inherit',
    windowsHide: false,
  })

  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
  })
  child.on('error', (error) => {
    console.error(`Unable to start tunnel-client: ${error.message}`)
    process.exitCode = 1
  })
}
