import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

async function withClient(
  toolsEnabled,
  callback,
  workspaceRootValue,
  workspaceAllowedValue,
  envOverrides = {}
) {
  const workspace = await mkdtemp(join(tmpdir(), 'mcp-server-test-'))
  const configuredRoot =
    typeof workspaceRootValue === 'function' ? workspaceRootValue(workspace) : workspaceRootValue
  const configuredEnv = typeof envOverrides === 'function' ? envOverrides(workspace) : envOverrides
  const env = { ...process.env }
  delete env.TOOLS_ENABLED
  delete env.MCP_WORKSPACE_ALLOWED
  delete env.BRAIN_ENABLED
  delete env.BRAIN_ACCESS
  Object.assign(env, {
    MCP_WORKSPACE_ROOT: configuredRoot ?? workspace,
    ...(workspaceAllowedValue ? { MCP_WORKSPACE_ALLOWED: workspaceAllowedValue(workspace) } : {}),
    BRAIN_ENABLED: 'false',
    ...configuredEnv,
  })
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

void test('unmatched allowed globs are tolerated when the root is valid', async () => {
  await withClient(
    undefined,
    async (client) => {
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'bash',
        'edit',
        'read',
        'write',
      ])
    },
    undefined,
    (workspace) => `${workspace},${join(workspace, 'missing-*')}`
  )
})

void test('rejects a missing primary workspace root during startup', async () => {
  await assert.rejects(
    withClient(
      undefined,
      async () => undefined,
      (workspace) => join(workspace, 'missing')
    )
  )
})

void test('TOOLS_ENABLED defaults to the four core tools', async () => {
  await withClient(undefined, async (client) => {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['bash', 'edit', 'read', 'write'])
    for (const tool of tools.tools) {
      assert.ok(tool.outputSchema, `${tool.name} should expose an output schema`)
    }
  })
})

void test('successful tool calls return structured content matching the output schema', async () => {
  await withClient(undefined, async (client, workspace) => {
    await writeFile(join(workspace, 'result.txt'), 'alpha')
    const result = await client.callTool({ name: 'read', arguments: { path: 'result.txt' } })
    assert.deepEqual(result.structuredContent, {
      path: 'result.txt',
      content: 'alpha',
      start_line: 1,
      end_line: 1,
      total_lines: 1,
      truncated: false,
    })
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

void test('TOOLS_ENABLED registers read_image alongside core tools', async () => {
  await withClient('read,write,edit,bash,read_image', async (client) => {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'bash',
      'edit',
      'read',
      'read_image',
      'write',
    ])
  })
})

void test('Brain read access binds to OpenAI session metadata with a fallback session', async () => {
  await withClient(
    '',
    async (client) => {
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'brain_absolute_path',
        'brain_cat',
        'brain_glob',
        'brain_grep',
        'brain_ls',
        'brain_think',
      ])

      for (const _meta of [undefined, { 'openai/session': '' }]) {
        const fallbackResult = await client.callTool({ name: 'brain_think', arguments: {}, _meta })
        assert.equal(fallbackResult.content[0].type, 'text')
        assert.match(
          fallbackResult.content[0].text,
          /path="@session\/chatgpt-web-mcp-tunnel\/core\.md"/
        )
      }

      for (const openAiSession of ['v1/test-session-a', 'v1/test-session-b']) {
        const sessionId = `chatgpt-web-${createHash('sha256').update(openAiSession).digest('hex')}`
        const result = await client.callTool({
          name: 'brain_think',
          arguments: {},
          _meta: { 'openai/session': openAiSession },
        })
        assert.equal(result.content[0].type, 'text')
        assert.match(result.content[0].text, new RegExp(`path="@session/${sessionId}/core\\.md"`))
      }
    },
    undefined,
    undefined,
    (workspace) => ({
      BRAIN_ENABLED: 'true',
      BRAIN_ACCESS: 'read',
      HOME: workspace,
      USERPROFILE: workspace,
    })
  )
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
