import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const projectRoot = process.cwd()
const sourceDirectory = path.join(projectRoot, 'scripts', 'tunnel-client')
const outputDirectory = path.join(projectRoot, 'dist-tunnel-client')
const bundleEntry = path.join(projectRoot, 'apps', 'mcp-server', 'src', 'index.ts')
const workspaceAliases = {
  '@workspace/pi-adapter': path.join(projectRoot, 'packages', 'pi-adapter', 'src', 'index.ts'),
  '@workspace/types': path.join(projectRoot, 'packages', 'types', 'src', 'index.ts'),
}
const outputEnvFile = path.join(outputDirectory, '.env.local')
const preservedEnv = fs.existsSync(outputEnvFile) ? fs.readFileSync(outputEnvFile) : undefined

fs.rmSync(outputDirectory, { recursive: true, force: true })
fs.mkdirSync(outputDirectory, { recursive: true })
fs.copyFileSync(
  path.join(sourceDirectory, 'start-cli.js'),
  path.join(outputDirectory, 'start-cli.js')
)

const sourceYaml = fs.readFileSync(path.join(sourceDirectory, 'tunnel-client.yaml'), 'utf8')
const bundledYaml = sourceYaml.replace(
  'command: pnpm start-mcp-server',
  'command: node ./mcp-server.mjs'
)
fs.writeFileSync(path.join(outputDirectory, 'tunnel-client.yaml'), bundledYaml)

if (preservedEnv !== undefined) fs.writeFileSync(outputEnvFile, preservedEnv)

await build({
  entryPoints: [bundleEntry],
  outfile: path.join(outputDirectory, 'mcp-server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  alias: workspaceAliases,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
})

const bundle = fs.readFileSync(path.join(outputDirectory, 'mcp-server.mjs'), 'utf8')
const normalizedRoot = projectRoot.replaceAll('\\', '/')
const leakedPath = [normalizedRoot, projectRoot].find((value) => bundle.includes(value))
if (leakedPath) throw new Error(`MCP bundle contains a development path: ${leakedPath}`)
if (fs.existsSync(path.join(outputDirectory, 'node_modules')))
  throw new Error('dist-tunnel-client must not contain node_modules')

console.log(`Built ${path.relative(projectRoot, outputDirectory)} with an independent MCP bundle.`)
