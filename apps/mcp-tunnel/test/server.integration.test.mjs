import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createDesktopNotifier } from '@workspace/mcp-tools-extra/notify'
import { parseEnabledToolNames } from '@workspace/mcp-tool-runtime'

const serverEntry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))

async function withClient(toolsEnabled, callback) {
  const workspace = await mkdtemp(join(tmpdir(), 'mcp-server-test-'))
  const env = { ...process.env, MCP_WORKSPACE_ROOT: workspace }
  if (toolsEnabled !== undefined) env.TOOLS_ENABLED = toolsEnabled
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-server-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    await callback(client, workspace)
  } finally {
    await client.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
  }
}

void test('TOOLS_ENABLED defaults to the four core tools', async () => {
  await withClient(undefined, async (client) => {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['bash', 'edit', 'read', 'write'])
  })
})

void test('extensions are opt-in and can run without core tools', async () => {
  await withClient('read_many', async (client, workspace) => {
    await writeFile(join(workspace, 'a.txt'), 'alpha')
    const tools = await client.listTools()
    assert.deepEqual(
      tools.tools.map((tool) => tool.name),
      ['read_many']
    )
    const result = await client.callTool({
      name: 'read_many',
      arguments: { files: [{ path: 'a.txt' }] },
    })
    assert.equal(result.content[0].type, 'text')
    assert.deepEqual(JSON.parse(result.content[0].text), {
      results: [
        {
          path: 'a.txt',
          content: 'alpha',
          start_line: 1,
          end_line: 1,
          total_lines: 1,
          truncated: false,
        },
      ],
    })
  })
})

void test('an empty allowlist exposes no tools and unknown names fail before startup', async () => {
  await withClient('', async (client) => {
    await assert.rejects(client.listTools(), /Method not found/)
  })
  assert.throws(
    () => parseEnabledToolNames('unknown', ['read'], ['notify']),
    /Unknown tool name\(s\) in TOOLS_ENABLED: unknown/
  )
})

void test('Windows notifier reads an external PowerShell script source', async () => {
  const calls = []
  const notifier = createDesktopNotifier(
    async () => '$title = $env:MCP_NOTIFY_TITLE',
    'win32',
    async (command) => calls.push(command)
  )
  await notifier.notify({ title: 'Build', message: 'Done' })
  assert.equal(calls[0].command, 'powershell.exe')
  assert.equal(calls[0].env.MCP_NOTIFY_TITLE, 'Build')
  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /MCP_NOTIFY_TITLE/)
})
