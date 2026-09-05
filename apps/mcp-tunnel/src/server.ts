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
  )
): Promise<McpServer> {
  logStartup('tool-selection', { enabledTools: [...enabledTools], workspaceRoot, workspaceAllowed })
  const server = new McpServer(
    { name: 'workspace-file-tools', version: '2.4.0' },
    enabledTools.has('notify')
      ? {
          instructions:
            'When a user task is fully complete, call the notify tool exactly once as the final tool call before returning the final answer. Do not notify for intermediate progress updates.',
        }
      : {}
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
  logStartup('tools-registered', { tools: registrations.map((registration) => registration.name) })
  return server
}

export async function startServer(workspaceRoot: string): Promise<void> {
  const server = await createServer(workspaceRoot)
  await server.connect(new StdioServerTransport())
}
