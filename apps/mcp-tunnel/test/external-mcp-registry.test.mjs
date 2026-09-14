import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  connectExternalMcpRegistry,
  loadAndConnectExternalMcpRegistry,
  loadExternalMcpConfigFile,
  parseExternalMcpConfig,
  resolveExternalMcpConfigPath,
} from '../dist/external-mcp-registry.mjs'
import { createServer } from '../dist/server.mjs'

const stdioFixture = fileURLToPath(new URL('./fixtures/external-mcp-stdio.mjs', import.meta.url))
const duplicateFixture = fileURLToPath(
  new URL('./fixtures/external-mcp-duplicate-tools.mjs', import.meta.url)
)
const serverEntry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))

function stdioEntry(env = {}) {
  return { command: process.execPath, args: [stdioFixture], env }
}

async function writeConfigFile(directory, value) {
  const filename = join(
    directory,
    `external-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  )
  await writeFile(filename, JSON.stringify(value))
  return filename
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

async function waitForProcessExit(pid, timeoutMs = 8000) {
  const started = Date.now()
  while (isProcessAlive(pid)) {
    if (Date.now() - started > timeoutMs) throw new Error(`Process ${pid} did not exit in time`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function startStatelessHttpFixture() {
  const seenHeaders = []
  // Stateful mode: SDK 1.29 stateless transports reject any second request on
  // the same instance ("Stateless transport cannot be reused across
  // requests"), so initialize + notifications/initialized + tools/list would
  // always fail with 500. A session-id transport supports the full handshake.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })
  const server = new Server(
    { name: 'external-mcp-http-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'fixture_remote_echo',
        description: 'Echo back over Streamable HTTP.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const value = request.params.arguments?.text
    const text = typeof value === 'string' ? value : ''
    return {
      content: [{ type: 'text', text }],
      structuredContent: { text },
    }
  })
  await server.connect(transport)
  const httpServer = http.createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    if (req.method === 'POST') seenHeaders.push({ ...req.headers })
    transport.handleRequest(req, res).catch((error) => {
      if (!res.headersSent)
        res.writeHead(500).end(error instanceof Error ? error.message : String(error))
    })
  })
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error)
    httpServer.once('error', onError)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError)
      resolve()
    })
  })
  const { port } = httpServer.address()
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenHeaders,
    async close() {
      await server.close().catch(() => undefined)
      // closeAllConnections releases keep-alive sockets held by the
      // Streamable HTTP client; without it httpServer.close() waits forever
      // and `node --test` hangs ("Interrupted while running").
      if (typeof httpServer.closeAllConnections === 'function') httpServer.closeAllConnections()
      await new Promise((resolve) => httpServer.close(resolve))
    },
  }
}

void test('unconfigured path resolves to an empty registry', async () => {
  assert.equal(resolveExternalMcpConfigPath(''), undefined)
  assert.equal(resolveExternalMcpConfigPath('   '), undefined)
  assert.equal(resolveExternalMcpConfigPath('  ./servers.json  '), './servers.json')
  const registry = await connectExternalMcpRegistry({})
  assert.equal(registry.size, 0)
  assert.deepEqual(registry.servers, [])
  assert.equal(registry.closed, false)
  await registry.close()
  await registry.close()
  assert.equal(registry.closed, true)
})

void test('schema rejects mixed, unknown, and missing fields with the server name', () => {
  assert.throws(
    () =>
      parseExternalMcpConfig({ mcpServers: { mixed: { command: 'node', url: 'http://x/mcp' } } }),
    /"mixed".*must not mix/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { bare: { cwd: '/tmp' } } }),
    /"bare".*either stdio/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { weird: { command: 'node', project: '.' } } }),
    /"weird".*unknown field.*"project"/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { empty: { command: '  ' } } }),
    /"empty".*non-empty "command"/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { bad: { url: 'not-a-url' } } }),
    /"bad".*valid absolute "url"/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { bad: { url: 'ws://example.invalid/mcp' } } }),
    /"bad".*http\(s\) "url"/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { bad: { command: 'node', headers: {} } } }),
    /"bad".*unknown field.*"headers"/
  )
  assert.throws(() => parseExternalMcpConfig({}), /must contain a "mcpServers" object/)
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: {}, projectPathFields: ['project'] }),
    /unknown field.*"projectPathFields"/
  )
  assert.throws(
    () => parseExternalMcpConfig({ mcpServers: { '  ': { command: 'x' } } }),
    /must not be empty/
  )
})

void test('valid stdio and Streamable HTTP entries parse without private fields', () => {
  const parsed = parseExternalMcpConfig({
    mcpServers: {
      local: { command: 'node', args: ['./server.mjs'], env: { KEY: 'value' }, cwd: '/tmp' },
      remote: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer token' } },
    },
  })
  assert.deepEqual(parsed, {
    local: { command: 'node', args: ['./server.mjs'], env: { KEY: 'value' }, cwd: '/tmp' },
    remote: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer token' } },
  })
})

void test('config file loading wraps missing files and bad JSON with the path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'external-mcp-config-'))
  try {
    const missing = join(directory, 'missing.json')
    await assert.rejects(
      loadExternalMcpConfigFile(missing),
      new RegExp(`Failed to load external MCP config from ".*missing.json"`)
    )
    const invalid = join(directory, 'invalid.json')
    await writeFile(invalid, '{not json')
    await assert.rejects(
      loadExternalMcpConfigFile(invalid),
      new RegExp(`Failed to parse external MCP config from ".*invalid.json"`)
    )
    const parsed = await loadExternalMcpConfigFile(
      await writeConfigFile(directory, { mcpServers: {} })
    )
    assert.deepEqual(parsed, {})
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('stdio server completes initialize and tools/list over a real transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'external-mcp-stdio-'))
  const registry = await connectExternalMcpRegistry({
    fixture: stdioEntry({ FIXTURE_PID_FILE: join(directory, 'fixture.pid') }),
  })
  try {
    assert.equal(registry.size, 1)
    const [entry] = registry.servers
    assert.equal(entry.name, 'fixture')
    assert.equal(entry.tools.length, 1)
    assert.equal(entry.tools[0].name, 'fixture_echo')
    assert.equal(entry.tools[0].title, 'Fixture Echo')
    assert.equal(entry.tools[0].description, 'Echo back the provided text.')
    assert.deepEqual(entry.tools[0].inputSchema, {
      type: 'object',
      properties: {
        text: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { $ref: '#/$defs/token' }, minItems: 1 },
          ],
        },
      },
      required: ['text'],
      additionalProperties: false,
      $defs: { token: { type: 'string', pattern: '^[a-z]+$' } },
    })
    assert.deepEqual(entry.tools[0].outputSchema, {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    })
    const result = await entry.client.callTool({
      name: 'fixture_echo',
      arguments: { text: 'hello' },
    })
    assert.deepEqual(result.structuredContent, { text: 'hello' })
    const pid = Number(await readFile(join(directory, 'fixture.pid'), 'utf8'))
    assert.ok(Number.isInteger(pid))
    assert.ok(isProcessAlive(pid))
    await registry.close()
    await registry.close()
    await waitForProcessExit(pid)
  } finally {
    await registry.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

void test('Streamable HTTP server completes discovery with headers over a real transport', async (t) => {
  let httpFixture
  try {
    httpFixture = await startStatelessHttpFixture()
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('sandbox does not permit binding a loopback HTTP fixture')
      return
    }
    throw error
  }
  try {
    const registry = await connectExternalMcpRegistry({
      remote: { url: httpFixture.url, headers: { 'x-fixture-token': 'secret' } },
    })
    try {
      assert.equal(registry.size, 1)
      const [entry] = registry.servers
      assert.deepEqual(
        entry.tools.map((tool) => tool.name),
        ['fixture_remote_echo']
      )
      const result = await entry.client.callTool({
        name: 'fixture_remote_echo',
        arguments: { text: 'remote-hello' },
      })
      assert.deepEqual(result.structuredContent, { text: 'remote-hello' })
      assert.ok(httpFixture.seenHeaders.length > 0)
      assert.ok(httpFixture.seenHeaders.every((headers) => headers['x-fixture-token'] === 'secret'))
    } finally {
      await registry.close()
      await registry.close()
    }
  } finally {
    await httpFixture.close()
  }
})

void test('duplicate tool names from one server fail closed and clean up siblings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'external-mcp-duplicate-'))
  try {
    await assert.rejects(
      connectExternalMcpRegistry({
        good: stdioEntry({ FIXTURE_PID_FILE: join(directory, 'good.pid') }),
        dup: { command: process.execPath, args: [duplicateFixture] },
      }),
      /Failed to connect external MCP server "dup".*Duplicate tool "duplicate_fixture_tool" discovered from external MCP server "dup"/
    )
    const pid = Number(await readFile(join(directory, 'good.pid'), 'utf8'))
    await waitForProcessExit(pid)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

void test('unstartable server fails closed naming the server and leaves no child behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'external-mcp-fail-closed-'))
  try {
    await assert.rejects(
      connectExternalMcpRegistry({
        good: stdioEntry({ FIXTURE_PID_FILE: join(directory, 'good.pid') }),
        broken: { command: 'definitely-not-a-real-mcp-binary-xyz' },
      }),
      /Failed to connect external MCP server "broken"/
    )
    const pid = Number(await readFile(join(directory, 'good.pid'), 'utf8'))
    await waitForProcessExit(pid)
    assert.ok(!isProcessAlive(pid))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function withTunnelServer(configValue, callback, envOverrides = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'mcp-tunnel-external-test-'))
  const configDirectory = await mkdtemp(join(tmpdir(), 'mcp-tunnel-external-config-'))
  const env = { ...process.env }
  delete env.TOOLS_ENABLED
  delete env.MCP_WORKSPACE_ALLOWED
  delete env.BRAIN_ENABLED
  delete env.BRAIN_ACCESS
  delete env.MCP_INSTRUCTIONS_FILE
  delete env.MCP_EXTERNAL_MCP_FILE
  Object.assign(env, {
    MCP_WORKSPACE_ROOT: workspace,
    BRAIN_ENABLED: 'false',
    ...envOverrides,
  })
  if (configValue !== undefined)
    env.MCP_EXTERNAL_MCP_FILE = await writeConfigFile(configDirectory, configValue)
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-tunnel-external-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    await callback(client)
  } finally {
    await client.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
    await rm(configDirectory, { recursive: true, force: true })
  }
}

void test('tunnel exposes external descriptors unchanged and proxies successful results', async () => {
  await withTunnelServer({ mcpServers: { fixture: stdioEntry() } }, async (client) => {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'bash',
      'edit',
      'fixture_echo',
      'read',
      'write',
    ])
    const tool = tools.tools.find((entry) => entry.name === 'fixture_echo')
    assert.deepEqual(tool, {
      name: 'fixture_echo',
      title: 'Fixture Echo',
      description: 'Echo back the provided text.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { $ref: '#/$defs/token' }, minItems: 1 },
            ],
          },
        },
        required: ['text'],
        additionalProperties: false,
        $defs: { token: { type: 'string', pattern: '^[a-z]+$' } },
      },
      outputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      annotations: {
        title: 'Fixture Echo Annotation',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { 'fixture/descriptor': 'preserved' },
    })
    const result = await client.callTool({
      name: 'fixture_echo',
      arguments: { text: ['alpha', 'beta'] },
    })
    assert.deepEqual(result, {
      content: [{ type: 'text', text: 'alpha,beta' }],
      structuredContent: { text: 'alpha,beta' },
      _meta: { 'fixture/result': 'preserved' },
    })
  })
})

void test('external isError results pass through and protocol failures are stable and sanitized', async () => {
  await withTunnelServer({ mcpServers: { fixture: stdioEntry() } }, async (client) => {
    const toolError = await client.callTool({
      name: 'fixture_echo',
      arguments: { text: '__tool_error__' },
    })
    assert.deepEqual(toolError, {
      isError: true,
      content: [{ type: 'text', text: 'controlled downstream tool failure' }],
      structuredContent: { text: 'tool-error' },
    })

    const protocolError = await client.callTool({
      name: 'fixture_echo',
      arguments: { text: '__protocol_error__' },
    })
    assert.equal(protocolError.isError, true)
    assert.equal(
      protocolError.content[0].text,
      'External MCP tool "fixture_echo" failed: downstream server "fixture" could not complete the request'
    )
    assert.doesNotMatch(protocolError.content[0].text, /sensitive downstream fixture detail/)
  })
})

void test('calls with distinct external names route to the owning downstream client', async () => {
  await withTunnelServer(
    {
      mcpServers: {
        first: stdioEntry({ FIXTURE_TOOL_NAME: 'fixture_first', FIXTURE_RESULT_PREFIX: 'first:' }),
        second: stdioEntry({
          FIXTURE_TOOL_NAME: 'fixture_second',
          FIXTURE_RESULT_PREFIX: 'second:',
        }),
      },
    },
    async (client) => {
      const first = await client.callTool({
        name: 'fixture_first',
        arguments: { text: 'value' },
      })
      const second = await client.callTool({
        name: 'fixture_second',
        arguments: { text: 'value' },
      })
      assert.equal(first.content[0].text, 'first:value')
      assert.equal(second.content[0].text, 'second:value')
    }
  )
})

void test('TOOLS_ENABLED is validated after discovery and can select only an external tool', async () => {
  await withTunnelServer(
    { mcpServers: { fixture: stdioEntry() } },
    async (client) => {
      const tools = await client.listTools()
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ['fixture_echo']
      )
    },
    { TOOLS_ENABLED: 'fixture_echo' }
  )
  await assert.rejects(
    withTunnelServer({ mcpServers: { fixture: stdioEntry() } }, async () => undefined, {
      TOOLS_ENABLED: 'fixture_missing',
    })
  )
})

void test('external tool conflicts fail closed and identify both sources', async () => {
  await assertCreateServerConflict(
    {
      first: stdioEntry({ FIXTURE_TOOL_NAME: 'shared_external' }),
      second: stdioEntry({ FIXTURE_TOOL_NAME: 'shared_external' }),
    },
    { enabled: false, access: 'read' },
    /Tool name conflict for "shared_external" between external MCP server "first" and external MCP server "second"/
  )
  await assertCreateServerConflict(
    { fixture: stdioEntry({ FIXTURE_TOOL_NAME: 'read' }) },
    { enabled: false, access: 'read' },
    /Tool name conflict for "read" between Tunnel built-in tools and external MCP server "fixture"/
  )
  await assertCreateServerConflict(
    { fixture: stdioEntry({ FIXTURE_TOOL_NAME: 'brain_think' }) },
    { enabled: true, access: 'read' },
    /Tool name conflict for "brain_think" between Brain tools and external MCP server "fixture"/
  )
})

async function assertCreateServerConflict(config, brain, expected) {
  const workspace = await mkdtemp(join(tmpdir(), 'mcp-tunnel-conflict-test-'))
  const registry = await connectExternalMcpRegistry(config)
  try {
    await assert.rejects(
      createServer(workspace, '', undefined, '', brain, undefined, registry),
      expected
    )
  } finally {
    await registry.close()
    await rm(workspace, { recursive: true, force: true })
  }
}

void test('tunnel fails closed when a configured external server cannot start', async () => {
  await assert.rejects(
    withTunnelServer(
      { mcpServers: { broken: { command: 'definitely-not-a-real-mcp-binary-xyz' } } },
      async () => undefined
    )
  )
})

void test('tunnel fails closed on an invalid external manifest', async () => {
  await assert.rejects(
    withTunnelServer(
      { mcpServers: { mixed: { command: 'node', url: 'http://x/mcp' } } },
      async () => undefined
    )
  )
})
