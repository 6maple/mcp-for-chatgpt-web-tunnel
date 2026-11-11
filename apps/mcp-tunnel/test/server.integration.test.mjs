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
import { createBrainInvocation } from '../src/brain-invocation.ts'
import { createFileRuntime, statePathFor } from 'brain/step'

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

void test('Brain read access restores the configured Global and Project cognition', async () => {
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
        'brain_think',
      ])

      const result = await client.callTool({ name: 'brain_think', arguments: {} })
      for (const tool of tools.tools) assert.equal(tool.outputSchema, undefined, tool.name)
      assert.equal(result.structuredContent, undefined)
      assert.notEqual(result.isError, true)
      assert.equal(result.content[0].type, 'text')
      assert.match(result.content[0].text, /@brain-virtual\/deep\.md/)
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

void test('Brain semantic config keeps think guidance and the public tool surface aligned', async () => {
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
        'brain_think',
      ])

      const think = await client.callTool({ name: 'brain_think', arguments: {} })
      for (const tool of tools.tools) assert.equal(tool.outputSchema, undefined, tool.name)
      assert.equal(think.structuredContent, undefined)
      assert.equal(think.content[0].type, 'text')
      assert.notEqual(think.isError, true)
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

void test('Brain step binds restored conversations and preserves Markdown State across MCP processes', async () => {
  await withClient(
    '',
    async (client, workspace) => {
      const meta = { 'openai/session': 'private-conversation-a' }
      const call = (name, args, requestMeta = meta, target = client) =>
        target.callTool({ name, arguments: args, _meta: requestMeta })
      const step = (args, requestMeta = meta, target = client) =>
        call('brain_step', args, requestMeta, target)
      const successText = (response) => {
        assert.notEqual(response.isError, true, response.content?.[0]?.text)
        assert.equal(response.structuredContent, undefined)
        assert.equal(response.content[0].type, 'text')
        return response.content[0].text
      }

      const before = await step({ action: 'start', message: 'round one' })
      assert.equal(before.isError, true)
      assert.match(before.content[0].text, /brain_think/)

      assert.notEqual((await call('brain_think', {})).isError, true)
      const deep = await call('brain_cat', { path: '@brain-virtual/deep.md' })
      assert.notEqual(deep.isError, true)
      assert.match(deep.content[0].text, /think-workflow/)

      const started = successText(await step({ action: 'start', message: 'round one' }))
      assert.match(started, /# Brain 的背景与目的/)
      assert.match(started, /# 当前任务：查清用户的完整意图/)
      const submitted = successText(
        await step({ action: 'submit_work', result: 'status: “Plan A” works.' })
      )
      assert.match(submitted, /完整客观检视/)
      const correction = successText(
        await step({ action: 'submit_review', result: 'Plan A 应改为 Plan B' })
      )
      assert.match(correction, /当前任务：修正完整意图/)
      assert.equal(
        successText(
          await step({
            action: 'update',
            edits: [{ old_text: '"Plan A" works', new_text: 'Plan B works' }],
          })
        ),
        '更新已保存。'
      )
      const currentText = successText(await step({ action: 'read' }))
      assert.match(currentText, /Plan B works/)
      assert.doesNotMatch(currentText, /Plan A/)

      const stateDirectory = join(workspace, '.brain-working', 'brain-step')
      const stateFiles = (await readdir(stateDirectory)).filter((name) => name.endsWith('.json'))
      assert.equal(stateFiles.length, 1)
      const stateFile = join(stateDirectory, stateFiles[0])
      const original = await readFile(stateFile, 'utf8')
      const json = JSON.parse(original)
      assert.equal(json.state.mode, 'fix')
      assert.match(json.state.contentFile, /\.md$/)
      assert.equal(json.state.content, undefined)
      assert.equal(
        await readFile(join(stateDirectory, json.state.contentFile), 'utf8'),
        currentText
      )
      assert.doesNotMatch(original, /Plan B works/)

      const duplicate = successText(await step({ action: 'start', message: 'round one' }))
      assert.match(duplicate, /当前任务：修正完整意图/)
      const missing = await step({ action: 'start', message: 'no identity' }, {})
      assert.equal(missing.isError, true)
      assert.match(missing.content[0].text, /openai\/session/)
      assert.equal(await readFile(stateFile, 'utf8'), original)

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
        assert.equal(successText(await step({ action: 'read' }, meta, replacement)), currentText)
        assert.match(
          successText(await step({ action: 'submit_work' }, meta, replacement)),
          /完整客观检视/
        )
        assert.match(
          successText(await step({ action: 'submit_review' }, meta, replacement)),
          /简短确认/
        )
        assert.match(
          successText(await step({ action: 'confirm_review' }, meta, replacement)),
          /事实本质/
        )

        const other = { 'openai/session': 'private-conversation-b' }
        assert.notEqual((await call('brain_think', {}, other, replacement)).isError, true)
        assert.match(
          successText(await step({ action: 'start', message: 'separate' }, other, replacement)),
          /查清用户的完整意图/
        )
        assert.equal(
          (await readdir(stateDirectory)).filter((name) => name.endsWith('.json')).length,
          2
        )
        assert.match(successText(await step({ action: 'read' }, other, replacement)), /当前 State/)
        assert.equal((await readFile(stateFile, 'utf8')) !== original, true) // Progress was saved.
        assert.match(successText(await step({ action: 'read' }, meta, replacement)), /Plan B works/)

        assert.notEqual((await call('brain_think', {}, meta, replacement)).isError, true)
        assert.equal((await step({ action: 'read' }, meta, replacement)).isError, true)
        assert.match(
          successText(await step({ action: 'start', message: 'round two' }, meta, replacement)),
          /查清用户的完整意图/
        )
        assert.doesNotMatch(
          successText(await step({ action: 'read' }, meta, replacement)),
          /Plan B/
        )
        assert.notEqual(await readFile(stateFile, 'utf8'), original)

        const bindings = join(workspace, '.brain-working', 'mcp-tunnel-invocations')
        for (const name of await readdir(bindings)) {
          assert.doesNotMatch(name, /private-conversation/)
          assert.doesNotMatch(await readFile(join(bindings, name), 'utf8'), /private-conversation/)
        }
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

void test('failed restore invalidates the old host turn without touching thinking State', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'brain-turn-failure-'))
  try {
    const invocation = createBrainInvocation(workspace)
    const callbacks = new Map()
    const registrar = invocation.registrar({
      registerTool(name, _config, callback) {
        callbacks.set(name, callback)
        return {}
      },
    })
    let fail = false
    registrar.registerTool('brain_think', {}, async () =>
      fail
        ? { isError: true, content: [{ type: 'text', text: 'restore failed' }] }
        : { content: [{ type: 'text', text: 'restored' }] }
    )
    const extra = { _meta: { 'openai/session': 'conversation', progressToken: 'keep-metadata' } }
    const think = callbacks.get('brain_think')
    await think({}, extra)
    const bound = await invocation.host(extra)
    assert.ok(bound.turnId)
    registrar.registerTool('brain_step', {}, async (_args, forwarded) => {
      assert.equal(forwarded._meta.progressToken, 'keep-metadata')
      assert.equal(forwarded._meta.threadId, bound.conversationId)
      assert.equal(forwarded._meta.turnId, bound.turnId)
      return { content: [{ type: 'text', text: 'forwarded' }] }
    })
    assert.notEqual((await callbacks.get('brain_step')({}, extra)).isError, true)
    const runtime = createFileRuntime({ resolveHost: () => invocation.host(extra) })
    await (await runtime(extra)).execute({ action: 'start', message: 'preserved work' })
    const state = statePathFor(bound)
    const original = await readFile(state, 'utf8')
    fail = true
    assert.equal((await think({}, extra)).isError, true)
    assert.equal((await invocation.host(extra)).turnId, '')
    assert.equal((await callbacks.get('brain_step')({}, extra)).isError, true)
    await assert.rejects(runtime(extra), /turnId/)
    assert.equal(await readFile(state, 'utf8'), original)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
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
