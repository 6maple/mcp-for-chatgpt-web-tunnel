import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const appRoot = fs.existsSync(path.join(scriptDirectory, 'assets', 'windows-toast.ps1'))
  ? scriptDirectory
  : path.resolve(scriptDirectory, '..')
const envFile = path.join(appRoot, '.env.local')
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
const executable = configuredPath
  ? path.resolve(appRoot, configuredPath)
  : path.join(appRoot, process.platform === 'win32' ? 'tunnel-client.exe' : 'tunnel-client')
const workspaceRoot = path.resolve(
  appRoot,
  fileEnv.MCP_WORKSPACE_ROOT || process.env.MCP_WORKSPACE_ROOT || appRoot
)
const windowsToastScript = path.join(appRoot, 'assets', 'windows-toast.ps1')
const windowsHide = process.platform === 'win32' && process.env.TUNNEL_WINDOWS_HIDE === 'true'

if (!fs.existsSync(executable)) {
  console.error(`Unable to find Tunnel Client: ${executable}`)
  console.error(
    'Place the platform Tunnel Client in this app directory or set TUNNEL_CLIENT_PATH in its .env.local.'
  )
  process.exitCode = 1
} else if (!fs.existsSync(configFile)) {
  console.error(`Unable to find tunnel-client config: ${configFile}`)
  process.exitCode = 1
} else {
  const child = spawn(executable, ['run', '--config', configFile], {
    cwd: appRoot,
    env: {
      ...process.env,
      ...fileEnv,
      MCP_WORKSPACE_ROOT: workspaceRoot,
      MCP_WINDOWS_TOAST_SCRIPT_PATH: windowsToastScript,
    },
    stdio: 'inherit',
    windowsHide,
  })
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (!child.killed) child.kill(signal)
    })
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
  })
  child.on('error', (error) => {
    console.error(`Unable to start Tunnel Client: ${error.message}`)
    process.exitCode = 1
  })
}
