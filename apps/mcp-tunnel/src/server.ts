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
  BRAIN_EXPLICIT_RESTORE_INSTRUCTIONS,
  DEFAULT_BRAIN_HOME,
  createProductionBrainServices,
  loadBrainGlobalConfig,
  registerBrainTools,
  type BrainApplicationServices,
  type BrainRuntimeFeatures,
} from 'brain/shared'
import { selectPublicBrainTools, type BrainToolName } from 'brain/public-tools'

const BRAIN_MUTATION_TOOL_NAMES: readonly BrainToolName[] = [
  'brain_write',
  'brain_edit',
  'brain_rm',
  'brain_mv',
  'brain_feedback',
]
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
  if (brain.enabled) instructions.push(BRAIN_EXPLICIT_RESTORE_INSTRUCTIONS)
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
    sourceRoot: string,
    options?: { readonly features?: BrainRuntimeFeatures }
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
    const globalConfig = loadBrainGlobalConfig(DEFAULT_BRAIN_HOME)
    for (const diagnostic of globalConfig.diagnostics)
      logStartup('brain-config-diagnostic', {
        code: diagnostic.code,
        message: diagnostic.message,
      })
    const features = globalConfig.features
    const brainServices = await createBrainServices(workspaceRoot, { features })
    registerBrainTools(server, brainServices, {
      exclude: excluded,
      features,
    })
    registeredTools.push(
      ...selectPublicBrainTools(features)
        .map((tool) => tool.name)
        .filter((name) => !excluded.includes(name))
    )
  }
  logStartup('tools-registered', { tools: registeredTools })
  return server
}

export async function startServer(workspaceRoot: string): Promise<void> {
  const server = await createServer(workspaceRoot)
  await server.connect(new StdioServerTransport())
}
