import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
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

const CHATGPT_WEB_MCP_TUNNEL_SESSION_ID = parseSessionId('chatgpt-web-mcp-tunnel')
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

function serverInstructions(brain: BrainConfiguration, notifyEnabled: boolean): string | undefined {
  const instructions: string[] = []
  if (brain.enabled)
    instructions.push(
      'Immediately after each new user message, call brain_think exactly once before substantive interpretation, planning, responding, or calling another tool. Use its returned context as current working cognition for the turn.'
    )
  if (notifyEnabled)
    instructions.push(
      'When a user task is fully complete, call the notify tool exactly once as the final tool call before returning the final answer. Do not notify for intermediate progress updates.'
    )
  return instructions.length === 0 ? undefined : instructions.join(' ')
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
  enabledTools = parseEnabledToolNames(
    process.env.TOOLS_ENABLED,
    CORE_TOOL_NAMES,
    Object.keys(EXTRA_TOOL_LOADERS)
  ),
  brain = resolveBrainConfiguration(),
  createBrainServices: (
    sourceRoot: string
  ) => Promise<BrainApplicationServices> = createProductionBrainServices
): Promise<McpServer> {
  logStartup('tool-selection', {
    enabledTools: [...enabledTools],
    brain,
    workspaceRoot,
    workspaceAllowed,
  })
  const instructions = serverInstructions(brain, enabledTools.has('notify'))
  const server = new McpServer(
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
  registerSelectedTools(server, registrations, enabledTools)
  const registeredTools = registrations
    .filter((registration) => enabledTools.has(registration.name))
    .map((registration) => registration.name)
  if (brain.enabled) {
    const excluded = brain.access === 'read' ? BRAIN_MUTATION_TOOL_NAMES : []
    registerBrainTools(
      server,
      await createBrainServices(workspaceRoot),
      CHATGPT_WEB_HOST_INVOCATION,
      {
        exclude: excluded,
      }
    )
    registeredTools.push(...BRAIN_TOOL_NAMES.filter((name) => !excluded.includes(name)))
  }
  logStartup('tools-registered', { tools: registeredTools })
  return server
}

export async function startServer(workspaceRoot: string): Promise<void> {
  const server = await createServer(workspaceRoot)
  await server.connect(new StdioServerTransport())
}
