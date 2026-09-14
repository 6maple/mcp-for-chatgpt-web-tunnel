import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { createPiAdapter, type PiAdapter } from '@workspace/pi-adapter'
import { CORE_TOOL_NAMES, createCoreToolRegistrations } from '@workspace/mcp-tools-core'
import { EXTRA_TOOL_LOADERS } from '@workspace/mcp-tools-extra/loaders'
import {
  parseEnabledToolNames,
  registerSelectedTools,
  type ToolRegistration,
} from '@workspace/mcp-tool-runtime'
import {
  createProductionBrainServices,
  parseSessionId,
  registerBrainTools,
  type BrainApplicationServices,
  type HostInvocationAdapter,
} from 'brain/shared'
import { BRAIN_TOOL_NAMES, type BrainToolName } from 'brain/public-tools'
import {
  loadAndConnectExternalMcpRegistry,
  resolveExternalMcpConfigPath,
  type ExternalMcpRegistry,
} from './external-mcp-registry.js'

const CHATGPT_WEB_MCP_TUNNEL_SESSION_ID = parseSessionId('chatgpt-web-mcp-tunnel')
// The SDK client defaults requests to 60 seconds. Proxy calls may legitimately
// run much longer, so leave their effective lifetime to upstream cancellation.
const PROXY_REQUEST_TIMEOUT_MS = 2_147_483_647
const BRAIN_MUTATION_TOOL_NAMES: readonly BrainToolName[] = [
  'brain_write',
  'brain_edit',
  'brain_rm',
  'brain_mv',
  'brain_feedback',
]
const HOST_SESSION_META_KEYS = [
  'threadId',
  'thread_id',
  'conversationId',
  'conversation_id',
  'sessionId',
  'session_id',
  'openai/session',
] as const

function scalarMetadata(value: unknown): string | number | boolean | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : undefined
}

function hashSessionValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function summarizeSessionMetadata(value: unknown): unknown {
  const scalar = scalarMetadata(value)
  if (typeof scalar !== 'string') return scalar
  return {
    length: scalar.length,
    sha256: hashSessionValue(scalar).slice(0, 16),
  }
}

function invocationMetadata(extra: unknown): Record<string, unknown> | undefined {
  if (typeof extra !== 'object' || extra === null) return undefined
  const meta = (extra as Record<string, unknown>)._meta
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : undefined
}

function resolveBrainSessionId(extra: unknown) {
  const openAiSession = invocationMetadata(extra)?.['openai/session']
  if (typeof openAiSession !== 'string' || openAiSession.trim().length === 0)
    return CHATGPT_WEB_MCP_TUNNEL_SESSION_ID
  return parseSessionId(`chatgpt-web-${hashSessionValue(openAiSession)}`)
}

function logHostInvocationMetadata(extra: unknown, brainSessionId: string): void {
  if (typeof extra !== 'object' || extra === null) {
    logStartup('brain-host-invocation', {
      extraType: typeof extra,
      brainSessionId,
      sessionSource: 'fallback',
    })
    return
  }
  const record = extra as Record<string, unknown>
  const meta = invocationMetadata(extra)
  const candidates = Object.fromEntries(
    HOST_SESSION_META_KEYS.flatMap((key) => {
      const value = summarizeSessionMetadata(meta?.[key])
      return value === undefined ? [] : [[key, value]]
    })
  )
  logStartup('brain-host-invocation', {
    sessionId: scalarMetadata(record.sessionId),
    requestId: scalarMetadata(record.requestId),
    metaKeys: meta === undefined ? [] : Object.keys(meta).sort(),
    metaSessionCandidates: candidates,
    brainSessionId,
    sessionSource:
      typeof meta?.['openai/session'] === 'string' && meta['openai/session'].trim().length > 0
        ? 'openai/session'
        : 'fallback',
  })
}

const CHATGPT_WEB_HOST_INVOCATION: HostInvocationAdapter = {
  currentSessionId: (extra) => {
    const brainSessionId = resolveBrainSessionId(extra)
    logHostInvocationMetadata(extra, brainSessionId)
    return brainSessionId
  },
}

export interface BrainConfiguration {
  readonly enabled: boolean
  readonly access: 'read' | 'write'
}

export function resolveBrainConfiguration(
  enabledValue = process.env.BRAIN_ENABLED,
  accessValue = process.env.BRAIN_ACCESS
): BrainConfiguration {
  if (enabledValue !== undefined && enabledValue !== 'true' && enabledValue !== 'false')
    throw new Error('BRAIN_ENABLED must be true or false')
  if (accessValue !== undefined && accessValue !== 'read' && accessValue !== 'write')
    throw new Error('BRAIN_ACCESS must be read or write')
  return { enabled: enabledValue === 'true', access: accessValue ?? 'read' }
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
    return resolve(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

async function serverInstructions(
  brain: BrainConfiguration,
  notifyEnabled: boolean,
  instructionsFile = process.env.MCP_INSTRUCTIONS_FILE
): Promise<string | undefined> {
  const instructions: string[] = []
  if (brain.enabled)
    instructions.push(
      'Immediately after each new user message, call brain_think exactly once before substantive interpretation, planning, responding, or calling another tool. Use its returned context as current working cognition for the turn.'
    )
  if (instructionsFile?.trim()) {
    const filename = resolveUserPath(instructionsFile)
    const content = (await readFile(filename, 'utf8')).trim()
    if (content) instructions.push(content)
    logStartup('instructions-loaded', { filename })
  }
  if (notifyEnabled)
    instructions.push(
      'When a user task is fully complete, call the notify tool exactly once as the final tool call before returning the final answer. Do not notify for intermediate progress updates.'
    )
  return instructions.length === 0 ? undefined : instructions.join('\n\n')
}

function defaultWindowsScriptSource(): Promise<string> {
  const filename =
    process.env.MCP_WINDOWS_TOAST_SCRIPT_PATH ??
    new URL('../assets/windows-toast.ps1', import.meta.url)
  return readFile(filename, 'utf8')
}

function logStartup(event: string, details: Record<string, unknown>): void {
  console.error(`[mcp-tunnel] ${event} ${JSON.stringify(details)}`)
}

/**
 * Resolve the single primary workspace root. Additional dynamic allow rules come from
 * MCP_WORKSPACE_ALLOWED and are resolved by the adapter for each request.
 */
export async function resolveWorkspaceRoot(
  value = process.env.MCP_WORKSPACE_ROOT
): Promise<string> {
  const root = (value ?? process.cwd()).trim()
  if (!root) throw new Error('MCP_WORKSPACE_ROOT must contain a path')
  const path = resolve(root)
  const metadata = await stat(path)
  if (!metadata.isDirectory()) throw new Error('MCP_WORKSPACE_ROOT must reference a directory')
  logStartup('workspace-root', { root: path })
  return path
}

export async function createServer(
  workspaceRoot: string,
  workspaceAllowed = process.env.MCP_WORKSPACE_ALLOWED,
  adapter: PiAdapter = createPiAdapter(workspaceRoot, workspaceAllowed),
  enabledToolsValue: string | ReadonlySet<string> | undefined = process.env.TOOLS_ENABLED,
  brain = resolveBrainConfiguration(),
  createBrainServices: (
    sourceRoot: string
  ) => Promise<BrainApplicationServices> = createProductionBrainServices,
  externalMcp?: ExternalMcpRegistry
): Promise<McpServer> {
  const builtInToolNames = [...CORE_TOOL_NAMES, ...Object.keys(EXTRA_TOOL_LOADERS)]
  const externalTools =
    externalMcp?.servers.flatMap((entry) => entry.tools.map((tool) => ({ entry, tool }))) ?? []
  const brainToolNames = brain.enabled
    ? BRAIN_TOOL_NAMES.filter(
        (name) => brain.access === 'write' || !BRAIN_MUTATION_TOOL_NAMES.includes(name)
      )
    : []
  assertUniqueToolNames([
    ...builtInToolNames.map((name) => ({ name, source: 'Tunnel built-in tools' })),
    ...brainToolNames.map((name) => ({ name, source: 'Brain tools' })),
    ...externalTools.map(({ entry, tool }) => ({
      name: tool.name,
      source: `external MCP server "${entry.name}"`,
    })),
  ])

  const enabledTools = new Set(
    typeof enabledToolsValue === 'string' || enabledToolsValue === undefined
      ? parseEnabledToolNames(enabledToolsValue, CORE_TOOL_NAMES, [
          ...Object.keys(EXTRA_TOOL_LOADERS),
          ...externalTools.map(({ tool }) => tool.name),
        ])
      : validateEnabledToolSet(enabledToolsValue, [
          ...builtInToolNames,
          ...externalTools.map(({ tool }) => tool.name),
        ])
  )
  if (enabledToolsValue === undefined)
    for (const { tool } of externalTools) enabledTools.add(tool.name)
  const selectedExternalTools = externalTools.filter(({ tool }) => enabledTools.has(tool.name))

  logStartup('tool-selection', {
    enabledTools: [...enabledTools],
    brain,
    workspaceRoot,
    workspaceAllowed,
  })
  const instructions = await serverInstructions(brain, enabledTools.has('notify'))
  const localServer = new McpServer(
    { name: 'workspace-file-tools', version: '2.4.0' },
    instructions === undefined ? {} : { instructions }
  )
  const registrations: ToolRegistration[] = [...createCoreToolRegistrations(adapter)]
  for (const name of enabledTools) {
    const loader = EXTRA_TOOL_LOADERS[name]
    if (!loader) continue
    try {
      const registration = await loader({
        workspaceRoot,
        workspaceAllowed,
        adapter,
        windowsScriptSource: defaultWindowsScriptSource,
      })
      registrations.push(registration)
      logStartup('tool-loader-ready', { tool: name })
    } catch (error) {
      logStartup('tool-loader-failed', {
        tool: name,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }
  registerSelectedTools(localServer, registrations, enabledTools)
  const registeredTools = registrations
    .filter((registration) => enabledTools.has(registration.name))
    .map((registration) => registration.name)
  if (brain.enabled) {
    const excluded = brain.access === 'read' ? BRAIN_MUTATION_TOOL_NAMES : []
    registerBrainTools(
      localServer,
      await createBrainServices(workspaceRoot),
      CHATGPT_WEB_HOST_INVOCATION,
      {
        exclude: excluded,
      }
    )
    registeredTools.push(...BRAIN_TOOL_NAMES.filter((name) => !excluded.includes(name)))
  }

  if (selectedExternalTools.length === 0) {
    logStartup('tools-registered', { tools: registeredTools })
    return localServer
  }

  const localTools = await connectLocalToolBackend(localServer, registeredTools.length > 0)
  const exposedTools: Tool[] = [
    ...localTools.tools,
    ...selectedExternalTools.map(({ tool }) => tool),
  ]
  const localToolNames = new Set(localTools.tools.map((tool) => tool.name))
  const externalByToolName = new Map(
    selectedExternalTools.map(({ entry, tool }) => [tool.name, entry] as const)
  )
  const server = new McpServer(
    { name: 'workspace-file-tools', version: '2.4.0' },
    instructions === undefined ? {} : { instructions }
  )
  server.server.registerCapabilities({ tools: {} })
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: exposedTools }))
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name
    if (localToolNames.has(name))
      return localTools.client!.request(
        { method: 'tools/call', params: request.params },
        CallToolResultSchema,
        { signal: extra.signal, timeout: PROXY_REQUEST_TIMEOUT_MS }
      )

    const entry = externalByToolName.get(name)
    if (entry === undefined) return toolFailure(`Tool "${name}" not found`)
    try {
      return await entry.client.request(
        { method: 'tools/call', params: request.params },
        CallToolResultSchema,
        { signal: extra.signal, timeout: PROXY_REQUEST_TIMEOUT_MS }
      )
    } catch (error) {
      logStartup('external-mcp-call-failed', {
        server: entry.name,
        tool: name,
        error: error instanceof Error ? error.message : typeof error,
      })
      return toolFailure(
        `External MCP tool "${name}" failed: downstream server "${entry.name}" could not complete the request`
      )
    }
  })

  const closeOuterServer = server.close.bind(server)
  server.close = async () => {
    await Promise.allSettled([closeOuterServer(), localTools.close()])
  }
  logStartup('tools-registered', { tools: exposedTools.map((tool) => tool.name) })
  return server
}

interface ToolSource {
  name: string
  source: string
}

function assertUniqueToolNames(tools: readonly ToolSource[]): void {
  const sources = new Map<string, string>()
  for (const tool of tools) {
    const previous = sources.get(tool.name)
    if (previous !== undefined)
      throw new Error(
        `Tool name conflict for "${tool.name}" between ${previous} and ${tool.source}`
      )
    sources.set(tool.name, tool.source)
  }
}

function validateEnabledToolSet(
  enabled: ReadonlySet<string>,
  available: readonly string[]
): ReadonlySet<string> {
  const unknown = [...enabled].filter((name) => !available.includes(name))
  if (unknown.length > 0)
    throw new Error(
      `Unknown tool name(s) in TOOLS_ENABLED: ${unknown.join(', ')}. Available tools: ${available.join(', ')}`
    )
  return new Set(enabled)
}

function toolFailure(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

async function connectLocalToolBackend(
  server: McpServer,
  hasTools: boolean
): Promise<{ tools: Tool[]; client?: Client; close(): Promise<void> }> {
  if (!hasTools) return { tools: [], close: async () => undefined }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'mcp-tunnel-local-tool-gateway', version: '1.0.0' })
  try {
    await server.connect(serverTransport)
    await client.connect(clientTransport)
    const tools = (await client.listTools()).tools
    return {
      tools,
      client,
      close: async () => {
        await Promise.allSettled([client.close(), server.close()])
      },
    }
  } catch (error) {
    await Promise.allSettled([client.close(), server.close()])
    throw error
  }
}

export async function startServer(workspaceRoot: string): Promise<void> {
  const externalMcp = await startExternalMcpRegistry()
  try {
    const server = await createServer(
      workspaceRoot,
      undefined,
      undefined,
      process.env.TOOLS_ENABLED,
      undefined,
      undefined,
      externalMcp
    )
    const transport = new StdioServerTransport()
    await server.connect(transport)
    const upstreamClosed = transport.onclose
    let closing = false
    transport.onclose = () => {
      upstreamClosed?.()
      if (closing) return
      closing = true
      void Promise.allSettled([server.close(), externalMcp.close()])
    }
  } catch (error) {
    await externalMcp.close()
    throw error
  }
}

async function startExternalMcpRegistry(): Promise<ExternalMcpRegistry> {
  const configPath = resolveExternalMcpConfigPath()
  const registry = await loadAndConnectExternalMcpRegistry(configPath)
  if (configPath !== undefined)
    logStartup('external-mcp-connected', {
      file: configPath,
      servers: registry.servers.map((entry) => ({
        name: entry.name,
        tools: entry.tools.map((tool) => tool.name),
      })),
    })
  forwardTerminationSignals(registry)
  return registry
}

function forwardTerminationSignals(registry: ExternalMcpRegistry): void {
  let shuttingDown = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      logStartup('external-mcp-shutdown', { signal })
      void registry
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
    })
}
