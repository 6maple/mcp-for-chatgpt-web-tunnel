import { glob, readFile, realpath, stat } from 'node:fs/promises'
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
 * Resolve comma-separated directory paths or glob patterns from MCP_WORKSPACE_ROOT.
 * Relative file paths use the first resolved root; absolute paths may use any resolved root.
 */
export async function resolveWorkspaceRoots(
  value = process.env.MCP_WORKSPACE_ROOT
): Promise<string[]> {
  const patterns = (value ?? process.cwd())
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean)
  if (patterns.length === 0) throw new Error('MCP_WORKSPACE_ROOT must contain at least one path')

  const roots: string[] = []
  for (const pattern of patterns) {
    const matches: string[] = []
    if (/[*?[]/.test(pattern)) {
      for await (const match of glob(pattern)) matches.push(match)
      if (matches.length === 0) {
        logStartup('workspace-root-pattern-skipped', { pattern })
        continue
      }
    } else matches.push(pattern)
    for (const match of matches) {
      const path = resolve(match)
      if (!(await stat(path)).isDirectory()) continue
      const canonical = await realpath(path)
      if (!roots.includes(canonical)) roots.push(canonical)
    }
  }
  if (roots.length === 0) throw new Error('MCP_WORKSPACE_ROOT did not resolve to any directories')
  return roots
}

export async function createServer(
  workspaceRoots: string | readonly string[],
  adapter: PiAdapter = createPiAdapter(workspaceRoots),
  enabledTools = parseEnabledToolNames(
    process.env.TOOLS_ENABLED,
    CORE_TOOL_NAMES,
    Object.keys(EXTRA_TOOL_LOADERS)
  )
): Promise<McpServer> {
  const roots = typeof workspaceRoots === 'string' ? [workspaceRoots] : [...workspaceRoots]
  logStartup('tool-selection', { enabledTools: [...enabledTools], workspaceRoots: roots })
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
        workspaceRoot: roots[0]!,
        workspaceRoots: roots,
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

export async function startServer(workspaceRoots: string | readonly string[]): Promise<void> {
  const server = await createServer(workspaceRoots)
  await server.connect(new StdioServerTransport())
}
