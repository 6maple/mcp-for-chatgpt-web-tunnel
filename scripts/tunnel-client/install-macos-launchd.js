import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.openai.mcp-tunnel'
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, '..', '..')
const TEMPLATE_PATH = path.join(SCRIPT_DIRECTORY, `${LABEL}.plist.template`)
const LAUNCH_AGENT_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
const LOG_DIRECTORY = path.join(os.homedir(), 'Library', 'Logs')
const FALLBACK_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']

function xmlEscape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function loadEnvFile(filename) {
  try {
    const source = await readFile(filename, 'utf8')
    const values = {}
    for (const line of source.split(/\r?\n/)) {
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
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

function proxyEnvironmentXml(environment) {
  return PROXY_NAMES.filter((name) => environment[name])
    .map((name) => `\t\t<key>${name}</key>\n\t\t<string>${xmlEscape(environment[name])}</string>`)
    .join('\n')
}

async function renderPlist() {
  const template = await readFile(TEMPLATE_PATH, 'utf8')
  const fileEnvironment = await loadEnvFile(path.join(PROJECT_ROOT, '.env.local'))
  const environment = { ...process.env, ...fileEnvironment }
  const replacements = {
    __NODE_PATH__: process.execPath,
    __PROJECT_ROOT__: PROJECT_ROOT,
    __PATH__: environment.PATH || FALLBACK_PATH,
    __LOG_DIRECTORY__: LOG_DIRECTORY,
  }

  let plist = template
  for (const [placeholder, value] of Object.entries(replacements))
    plist = plist.replaceAll(placeholder, xmlEscape(value))
  plist = plist.replace('__PROXY_ENVIRONMENT__', proxyEnvironmentXml(environment))
  return plist
}

function runLaunchctl(args, options = {}) {
  const result = spawnSync('/bin/launchctl', args, {
    stdio: options.stdio ?? 'inherit',
    encoding: 'utf8',
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.ignoreFailure)
    throw new Error(`launchctl ${args.join(' ')} failed with exit code ${result.status}`)
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('macOS launchd installation is only supported on macOS')

  const plist = await renderPlist()
  if (process.argv.includes('--print')) {
    process.stdout.write(plist)
    return
  }

  await mkdir(path.dirname(LAUNCH_AGENT_PATH), { recursive: true })
  await writeFile(LAUNCH_AGENT_PATH, plist, { encoding: 'utf8', mode: 0o600 })
  await chmod(LAUNCH_AGENT_PATH, 0o600)

  const domain = `gui/${process.getuid()}`
  runLaunchctl(['bootout', domain, LAUNCH_AGENT_PATH], {
    stdio: 'ignore',
    ignoreFailure: true,
  })
  runLaunchctl(['bootstrap', domain, LAUNCH_AGENT_PATH])
  console.log(`Installed and loaded ${LAUNCH_AGENT_PATH}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
