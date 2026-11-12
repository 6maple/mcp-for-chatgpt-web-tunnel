import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createDesktopNotifier, createNotifyTool } from '@workspace/mcp-tools-extra/notify'
import { parseEnabledToolNames } from '@workspace/mcp-tool-runtime'

const serverEntry =
  process.env.MCP_TEST_SERVER_ENTRY ?? fileURLToPath(new URL('../dist/index.mjs', import.meta.url))

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
  const configuredEnv =
    typeof envOverrides === 'function' ? await envOverrides(workspace) : envOverrides
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
  await withClient(undefined, async (client) => {
    await client.listTools()
    const written = await client.callTool({
      name: 'write',
      arguments: { path: 'result.txt', content: 'alpha' },
    })
    assert.notEqual(written.isError, true)
    assert.deepEqual(written.structuredContent, { path: 'result.txt', bytes: 5 })
    const edited = await client.callTool({
      name: 'edit',
      arguments: { path: 'result.txt', old_string: 'alpha', new_string: 'bravo' },
    })
    assert.notEqual(edited.isError, true)
    assert.deepEqual(edited.structuredContent, { path: 'result.txt', matches: 1 })
    const result = await client.callTool({ name: 'read', arguments: { path: 'result.txt' } })
    assert.notEqual(result.isError, true)
    assert.deepEqual(result.structuredContent, {
      path: 'result.txt',
      content: 'bravo',
      start_line: 1,
      end_line: 1,
      total_lines: 1,
      truncated: false,
    })
    const command =
      process.platform === 'win32' ? "Write-Output 'schema-check'" : "printf 'schema-check\\n'"
    const executed = await client.callTool({ name: 'bash', arguments: { command } })
    assert.notEqual(executed.isError, true)
    assert.equal(executed.structuredContent.exit_code, 0)
    assert.match(executed.structuredContent.stdout, /schema-check/)
    const missing = await client.callTool({ name: 'read', arguments: { path: 'missing.txt' } })
    assert.equal(missing.isError, true)
    assert.equal(missing.structuredContent, undefined)
    assert.equal(missing.content[0].type, 'text')
  })
})

void test('all plugin business tools advertise their actual structured result fields', async () => {
  const fields = {
    read: ['path', 'content', 'start_line', 'end_line', 'total_lines', 'truncated'],
    write: ['path', 'bytes'],
    edit: ['path', 'matches'],
    bash: ['exit_code', 'stdout', 'stderr', 'truncated'],
    read_many: ['results'],
    edit_many: ['results'],
    read_image: [
      'path',
      'mimeType',
      'bytes',
      'originalBytes',
      'originalWidth',
      'originalHeight',
      'width',
      'height',
      'compressed',
      'metrics',
    ],
    notify: ['notified', 'platform', 'title', 'message'],
  }
  await withClient(Object.keys(fields).join(','), async (client, workspace) => {
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      Object.keys(fields).sort((a, b) => a.localeCompare(b))
    )
    for (const tool of listed.tools) {
      assert.equal(tool.outputSchema.type, 'object', tool.name)
      assert.equal(tool.outputSchema.additionalProperties, false, tool.name)
      assert.deepEqual(
        Object.keys(tool.outputSchema.properties).sort((a, b) => a.localeCompare(b)),
        [...fields[tool.name]].sort((a, b) => a.localeCompare(b)),
        tool.name
      )
    }
    await writeFile(join(workspace, 'batch.txt'), 'alpha')
    const edited = await client.callTool({
      name: 'edit_many',
      arguments: { edits: [{ path: 'batch.txt', old_string: 'alpha', new_string: 'bravo' }] },
    })
    assert.notEqual(edited.isError, true)
    assert.deepEqual(edited.structuredContent, { results: [{ path: 'batch.txt', matches: 1 }] })
    const read = await client.callTool({
      name: 'read_many',
      arguments: { files: [{ path: 'batch.txt' }] },
    })
    assert.notEqual(read.isError, true)
    assert.equal(read.structuredContent.results[0].content, 'bravo')
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64'
    )
    await writeFile(join(workspace, 'pixel.png'), png)
    const image = await client.callTool({ name: 'read_image', arguments: { path: 'pixel.png' } })
    assert.notEqual(image.isError, true)
    assert.equal(image.structuredContent.mimeType, 'image/png')
    assert.equal(image.structuredContent.width, 1)
    assert.equal(image.structuredContent.height, 1)
    assert.equal(image.content[0].type, 'image')
    assert.equal(image.structuredContent.data, undefined)
  })
})

void test('notification output matches its advertised schema without sending a notification', async () => {
  const server = new McpServer({ name: 'notify-schema-test', version: '1.0.0' })
  const notifier = createDesktopNotifier(
    async () => '',
    'win32',
    async () => undefined
  )
  createNotifyTool(notifier).register(server)
  const client = new Client({ name: 'notify-schema-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await client.listTools()
    const result = await client.callTool({
      name: 'notify',
      arguments: { title: 'Build', message: 'Done' },
    })
    assert.notEqual(result.isError, true)
    assert.deepEqual(result.structuredContent, {
      notified: true,
      platform: 'Windows',
      title: 'Build',
      message: 'Done',
    })
  } finally {
    await client.close()
    await server.close()
  }
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

void test('Brain read access exposes Step and reads the configured Global and Project cognition', async () => {
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
        'brain_step',
      ])

      for (const tool of tools.tools) assert.equal(tool.outputSchema, undefined, tool.name)
      const memory = await client.callTool({
        name: 'brain_cat',
        arguments: { path: '@brain-virtual/deep-memory.md' },
      })
      assert.notEqual(memory.isError, true)
      assert.match(memory.content[0].text, /path="@global\/core\.md"/)
      assert.match(memory.content[0].text, /path="@project\/core\.md"/)
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

void test('Brain semantic config aligns memory guidance and the public tool surface', async () => {
  await withClient(
    '',
    async (client) => {
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
        'brain_absolute_path',
        'brain_ask_search',
        'brain_cat',
        'brain_glob',
        'brain_grep',
        'brain_ls',
        'brain_step',
      ])

      for (const tool of tools.tools) assert.equal(tool.outputSchema, undefined, tool.name)
      const memory = await client.callTool({
        name: 'brain_cat',
        arguments: { path: '@brain-virtual/deep-memory.md' },
      })
      assert.match(memory.content[0].text, /brain_ask_search/)

      const search = await client.callTool({
        name: 'brain_ask_search',
        arguments: { query: 'relevant past cognition' },
      })
      assert.equal(search.isError, true)
      assert.match(search.content[0].text, /semantic-search-unavailable/)
    },
    undefined,
    undefined,
    async (workspace) => {
      const brainHome = join(workspace, '.brain-data')
      await mkdir(brainHome, { recursive: true })
      await writeFile(
        join(brainHome, 'config.json'),
        JSON.stringify({ semanticSearch: { enabled: true } })
      )
      return {
        BRAIN_ENABLED: 'true',
        BRAIN_ACCESS: 'read',
        HOME: workspace,
        USERPROFILE: workspace,
      }
    }
  )
})

void test('Brain Step uses issued IDs across MCP processes and isolates identical messages', async () => {
  await withClient(
    '',
    async (client, workspace) => {
      const step = (args, target = client) =>
        target.callTool({ name: 'brain_step', arguments: args })
      const success = (response, turnId) => {
        assert.notEqual(response.isError, true, response.content?.[0]?.text)
        assert.equal(response.structuredContent, undefined)
        assert.equal(response.content[0].type, 'text')
        const returnedId = response.content[1]?.text.match(/[0-9a-f-]{36}/)?.[0]
        assert.ok(returnedId, 'the model can read the turn ID from the response')
        if (turnId) assert.equal(returnedId, turnId)
        return { text: response.content[0].text, turnId: returnedId }
      }

      const request = { action: 'start', message: 'same user message' }
      const first = success(await step(request))
      const second = success(await step(request))
      assert.match(first.text, /Background \+ Goal \/ Work/)
      assert.notEqual(first.turnId, second.turnId)
      const { turnId } = first
      assert.match(
        success(await step({ action: 'submit_work', turnId, result: 'Plan A works.' }), turnId)
          .text,
        /\/ Review/
      )
      assert.match(
        success(
          await step({ action: 'submit_review', turnId, result: 'Change Plan A to Plan B.' }),
          turnId
        ).text,
        /\/ Fix/
      )
      success(
        await step({
          action: 'update',
          turnId,
          edits: [{ old_text: 'Plan A', new_text: 'Plan B' }],
        }),
        turnId
      )
      const current = success(await step({ action: 'read', turnId }), turnId).text
      assert.match(current, /Plan B works/)
      assert.doesNotMatch(
        success(await step({ action: 'read', turnId: second.turnId }), second.turnId).text,
        /Plan B works/
      )

      const replacement = new Client({ name: 'replacement', version: '1.0.0' })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: {
          ...process.env,
          TOOLS_ENABLED: '',
          BRAIN_ENABLED: 'true',
          BRAIN_ACCESS: 'read',
          MCP_WORKSPACE_ROOT: workspace,
          HOME: workspace,
          USERPROFILE: workspace,
        },
        stderr: 'pipe',
      })
      try {
        await replacement.connect(transport)
        assert.equal(
          success(await step({ action: 'read', turnId }, replacement), turnId).text,
          current
        )
        assert.match(
          success(await step({ ...request, turnId }, replacement), turnId).text,
          /\/ Fix/
        )
        assert.match(
          success(await step({ action: 'submit_work', turnId }, replacement), turnId).text,
          /\/ Review/
        )
        assert.match(
          success(await step({ action: 'submit_review', turnId }, replacement), turnId).text,
          /\/ Confirm/
        )
        assert.match(
          success(await step({ action: 'confirm_review', turnId }, replacement), turnId).text,
          /Method \/ Work/
        )
        for (const invalid of [
          { action: 'read' },
          { action: 'read', turnId: 'host-session' },
          { action: 'read', turnId: '00000000-0000-4000-8000-000000000000' },
        ]) {
          const response = await step(invalid, replacement)
          assert.equal(response.isError, true)
          assert.match(response.content[0].text, /turnId/)
        }
        const files = await readdir(join(workspace, '.brain-working', 'brain-step'))
        assert.equal(files.filter((name) => name.endsWith('.json')).length, 2)
      } finally {
        await replacement.close()
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
