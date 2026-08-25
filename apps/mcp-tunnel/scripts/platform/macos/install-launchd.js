import { spawnSync } from 'node:child_process'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const platformDirectory = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(platformDirectory, '..', '..', '..')
const label = 'com.openai.mcp-tunnel'
const target = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
const template = path.join(platformDirectory, `${label}.plist.template`)
const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('macOS launchd installation is only supported on macOS')
  const plist = (await readFile(template, 'utf8'))
    .replaceAll('__NODE_PATH__', escape(process.execPath))
    .replaceAll('__APP_ROOT__', escape(appRoot))
    .replaceAll(
      '__PATH__',
      escape(process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    )
    .replaceAll('__LOG_DIRECTORY__', escape(path.join(os.homedir(), 'Library', 'Logs')))
  if (process.argv.includes('--print')) {
    process.stdout.write(plist)
    return
  }
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, plist, { encoding: 'utf8', mode: 0o600 })
  await chmod(target, 0o600)
  const domain = `gui/${process.getuid()}`
  spawnSync('/bin/launchctl', ['bootout', domain, target], { stdio: 'ignore' })
  const result = spawnSync('/bin/launchctl', ['bootstrap', domain, target], { stdio: 'inherit' })
  if (result.status !== 0)
    throw new Error(`launchctl bootstrap failed with exit code ${result.status}`)
  console.log(`Installed and loaded ${target}`)
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
