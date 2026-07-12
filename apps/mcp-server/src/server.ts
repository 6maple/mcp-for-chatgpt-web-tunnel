import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createPiAdapter, type PiAdapter } from '@workspace/pi-adapter'
import type { BashInput, EditInput, ReadInput, WriteInput } from '@workspace/types'

function text(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: JSON.stringify(value, null, 2) }
}

export function createServer(
  workspaceRoot: string,
  adapter: PiAdapter = createPiAdapter(workspaceRoot)
): McpServer {
  const server = new McpServer({ name: 'workspace-file-tools', version: '2.0.0' })
  const result = (value: unknown) => ({
    content: [text(value)],
    structuredContent: value as Record<string, unknown>,
  })
  const failure = (error: unknown) => ({
    isError: true,
    content: [
      { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
    ],
  })

  server.registerTool(
    'read',
    {
      description: 'Read a text file inside the workspace.',
      inputSchema: z.strictObject({ path: z.string() }),
    },
    async (args) => {
      try {
        return result(await adapter.read(args as ReadInput))
      } catch (error) {
        return failure(error)
      }
    }
  )
  server.registerTool(
    'write',
    {
      description: 'Create or overwrite a text file inside the workspace.',
      inputSchema: z.strictObject({ path: z.string(), content: z.string() }),
    },
    async (args) => {
      try {
        return result(await adapter.write(args as WriteInput))
      } catch (error) {
        return failure(error)
      }
    }
  )
  server.registerTool(
    'edit',
    {
      description: 'Replace one exact string inside a workspace file.',
      inputSchema: z.strictObject({
        path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
      }),
    },
    async (args) => {
      try {
        return result(await adapter.edit(args as EditInput))
      } catch (error) {
        return failure(error)
      }
    }
  )
  server.registerTool(
    'bash',
    {
      description: 'Execute a PowerShell command in the workspace on Windows, or bash elsewhere.',
      inputSchema: z.strictObject({ command: z.string(), timeout_ms: z.number().optional() }),
    },
    async (args) => {
      try {
        return result(await adapter.bash(args as BashInput))
      } catch (error) {
        return failure(error)
      }
    }
  )

  return server
}

export async function startServer(workspaceRoot: string): Promise<void> {
  const server = createServer(workspaceRoot)
  await server.connect(new StdioServerTransport())
}
