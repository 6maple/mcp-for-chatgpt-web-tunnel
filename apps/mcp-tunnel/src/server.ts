import { readFile } from 'node:fs/promises'
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

export async function createServer(
  workspaceRoot: string,
  adapter: PiAdapter = createPiAdapter(workspaceRoot),
  enabledTools = parseEnabledToolNames(
    process.env.TOOLS_ENABLED,
    CORE_TOOL_NAMES,
    Object.keys(EXTRA_TOOL_LOADERS)
  )
): Promise<McpServer> {
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
    if (loader)
      registrations.push(
        await loader({ workspaceRoot, adapter, windowsScriptSource: defaultWindowsScriptSource })
      )
  }
  registerSelectedTools(server, registrations, enabledTools)
  return server
}

export async function startServer(workspaceRoot: string): Promise<void> {
  const server = await createServer(workspaceRoot)
  await server.connect(new StdioServerTransport())
}

export const resolveWorkspaceRoot = () => resolve(process.env.MCP_WORKSPACE_ROOT ?? process.cwd())
