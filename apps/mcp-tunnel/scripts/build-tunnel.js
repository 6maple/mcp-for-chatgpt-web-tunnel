import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(scriptsDirectory, '..')
const projectRoot = path.resolve(appRoot, '..', '..')
const brainRoot = path.resolve(projectRoot, '.brain-source')
const outputDirectory = path.join(appRoot, 'dist-tunnel-client')
const outputEnvFile = path.join(outputDirectory, '.env.local')
const preservedEnv = fs.existsSync(outputEnvFile) ? fs.readFileSync(outputEnvFile) : undefined
const aliases = {
  '@workspace/pi-adapter': path.join(projectRoot, 'packages', 'pi-adapter', 'src', 'index.ts'),
  '@workspace/types': path.join(projectRoot, 'packages', 'types', 'src', 'index.ts'),
  '@workspace/mcp-tool-runtime': path.join(
    projectRoot,
    'packages',
    'mcp-tool-runtime',
    'src',
    'index.ts'
  ),
  '@workspace/mcp-tools-core': path.join(
    projectRoot,
    'packages',
    'mcp-tools-core',
    'src',
    'index.ts'
  ),
  '@workspace/mcp-tools-extra/loaders': path.join(
    projectRoot,
    'packages',
    'mcp-tools-extra',
    'src',
    'loaders.ts'
  ),
  '@workspace/mcp-tools-extra/read-image': path.join(
    projectRoot,
    'packages',
    'mcp-tools-extra',
    'src',
    'read-image.ts'
  ),
  '@workspace/mcp-tools-extra/read-many': path.join(
    projectRoot,
    'packages',
    'mcp-tools-extra',
    'src',
    'read-many.ts'
  ),
  '@workspace/mcp-tools-extra/edit-many': path.join(
    projectRoot,
    'packages',
    'mcp-tools-extra',
    'src',
    'edit-many.ts'
  ),
  '@workspace/mcp-tools-extra/notify': path.join(
    projectRoot,
    'packages',
    'mcp-tools-extra',
    'src',
    'notify.ts'
  ),
  '@workspace/mcp-image-adapter': path.join(
    projectRoot,
    'packages',
    'mcp-image-adapter',
    'src',
    'index.ts'
  ),
  'brain/shared': path.join(brainRoot, 'src', 'shared.ts'),
  'brain/public-tools': path.join(brainRoot, 'src', 'public-tools.ts'),
}

fs.rmSync(outputDirectory, { recursive: true, force: true })
fs.mkdirSync(path.join(outputDirectory, 'assets'), { recursive: true })
fs.copyFileSync(
  path.join(scriptsDirectory, 'start-cli.js'),
  path.join(outputDirectory, 'start-cli.js')
)
fs.copyFileSync(
  path.join(scriptsDirectory, 'start-pm2.js'),
  path.join(outputDirectory, 'start-pm2.js')
)
fs.copyFileSync(
  path.join(scriptsDirectory, 'ecosystem.config.cjs'),
  path.join(outputDirectory, 'ecosystem.config.cjs')
)
fs.copyFileSync(
  path.join(appRoot, 'assets', 'windows-toast.ps1'),
  path.join(outputDirectory, 'assets', 'windows-toast.ps1')
)
const sourceYaml = fs.readFileSync(path.join(scriptsDirectory, 'tunnel-client.yaml'), 'utf8')
fs.writeFileSync(
  path.join(outputDirectory, 'tunnel-client.yaml'),
  sourceYaml.replace('command: pnpm start:server', 'command: node ./mcp-server.mjs')
)
if (preservedEnv !== undefined) fs.writeFileSync(outputEnvFile, preservedEnv)

await build({
  entryPoints: { 'mcp-server': path.join(appRoot, 'src', 'index.ts') },
  outdir: outputDirectory,
  entryNames: '[name]',
  chunkNames: 'chunks/[name]-[hash]',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  splitting: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  packages: 'bundle',
  alias: aliases,
  banner: {
    js: "import { createRequire as createRequireForBundle } from 'node:module'; const require = createRequireForBundle(import.meta.url);",
  },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
})

const normalizedRoot = projectRoot.replaceAll('\\', '/')
const normalizedBrainRoot = brainRoot.replaceAll('\\', '/')
for (const filename of fs.readdirSync(outputDirectory, { recursive: true })) {
  const candidate = path.join(outputDirectory, filename)
  if (!candidate.endsWith('.mjs')) continue
  const source = fs.readFileSync(candidate, 'utf8')
  if (
    source.includes(normalizedRoot) ||
    source.includes(projectRoot) ||
    source.includes(normalizedBrainRoot) ||
    source.includes(brainRoot)
  )
    throw new Error(`MCP bundle contains a development path: ${candidate}`)
}
if (fs.existsSync(path.join(outputDirectory, 'node_modules')))
  throw new Error('dist-tunnel-client must not contain node_modules')
console.log(
  `Built ${path.relative(projectRoot, outputDirectory)} with independently loadable extension chunks.`
)
