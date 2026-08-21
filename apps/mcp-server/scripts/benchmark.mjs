import { performance } from 'node:perf_hooks'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverEntry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))

function percentile(sorted, value) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    n: sorted.length,
    average_ms: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50_ms: percentile(sorted, 0.5),
    p95_ms: percentile(sorted, 0.95),
  }
}

async function measure(name, callback, iterations) {
  for (let index = 0; index < 5; index += 1) await callback()
  const values = []
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now()
    await callback()
    values.push(performance.now() - start)
  }
  const result = summarize(values)
  console.log(
    `${name}: n=${result.n} avg=${result.average_ms.toFixed(3)}ms p50=${result.p50_ms.toFixed(3)}ms p95=${result.p95_ms.toFixed(3)}ms`
  )
  return result
}

const workspace = await mkdtemp(join(tmpdir(), 'mcp-benchmark-'))
const files = Array.from({ length: 5 }, (_, index) => `file-${index + 1}.txt`)
for (const [index, path] of files.entries())
  await writeFile(join(workspace, path), `${index}\n${'x'.repeat(10_000)}`)

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  env: { ...process.env, MCP_WORKSPACE_ROOT: workspace },
  stderr: 'pipe',
})
const client = new Client({ name: 'mcp-benchmark', version: '1.0.0' })

try {
  await client.connect(transport)
  console.log('Isolated local MCP benchmark; the running tunnel-client is not used or restarted.')
  await measure(
    'read one 10KB file',
    () => client.callTool({ name: 'read', arguments: { path: files[0] } }),
    100
  )
  await measure(
    'bash true',
    () => client.callTool({ name: 'bash', arguments: { command: 'true' } }),
    50
  )
  await measure(
    'five sequential read calls',
    async () => {
      for (const path of files)
        await client.callTool({ name: 'read', arguments: { path, max_chars: 1_000 } })
    },
    50
  )
  await measure(
    'one read_many call for five files',
    () =>
      client.callTool({
        name: 'read_many',
        arguments: { files: files.map((path) => ({ path, max_chars: 1_000 })) },
      }),
    50
  )

  const response = await client.callTool({ name: 'read', arguments: { path: files[0] } })
  const parsed = JSON.parse(response.content[0].text)
  const currentBytes = Buffer.byteLength(JSON.stringify(response))
  const oldShapeBytes = Buffer.byteLength(
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(parsed, null, 2) }],
      structuredContent: parsed,
    })
  )
  console.log(
    `10KB read response size: optimized=${currentBytes}B simulated-old=${oldShapeBytes}B reduction=${((1 - currentBytes / oldShapeBytes) * 100).toFixed(1)}%`
  )
} finally {
  await client.close().catch(() => undefined)
  await rm(workspace, { recursive: true, force: true })
}
