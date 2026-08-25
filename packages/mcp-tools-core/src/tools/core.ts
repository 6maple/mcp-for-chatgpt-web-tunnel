import { z } from 'zod'
import type { PiAdapter } from '@workspace/pi-adapter'
import type { BashInput, EditInput, ReadInput, WriteInput } from '@workspace/types'
import { compactResult, failureResult, type ToolRegistration } from '@workspace/mcp-tool-runtime'

export const CORE_TOOL_NAMES = ['read', 'write', 'edit', 'bash'] as const
const positiveInteger = z.number().int().positive()
const readInputSchema = z.strictObject({
  path: z.string(),
  start_line: positiveInteger.optional(),
  line_count: positiveInteger.max(1_000_000).optional(),
  max_chars: positiveInteger.max(1_000_000).optional(),
})
const editInputSchema = z.strictObject({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
})

function tool(name: string, register: ToolRegistration['register']): ToolRegistration {
  return { name, register }
}

export function createCoreToolRegistrations(adapter: PiAdapter): ToolRegistration[] {
  return [
    tool('read', (server) =>
      server.registerTool(
        'read',
        {
          description:
            'Read a text file inside the workspace. start_line is 1-based; line_count limits returned lines. Results default to at most 50,000 characters.',
          inputSchema: readInputSchema,
        },
        async (args) => {
          try {
            return compactResult(await adapter.read(args as ReadInput))
          } catch (error) {
            return failureResult(error)
          }
        }
      )
    ),
    tool('write', (server) =>
      server.registerTool(
        'write',
        {
          description: 'Create or overwrite a text file inside the workspace.',
          inputSchema: z.strictObject({ path: z.string(), content: z.string() }),
        },
        async (args) => {
          try {
            return compactResult(await adapter.write(args as WriteInput))
          } catch (error) {
            return failureResult(error)
          }
        }
      )
    ),
    tool('edit', (server) =>
      server.registerTool(
        'edit',
        {
          description: 'Replace one exact string inside a workspace file.',
          inputSchema: editInputSchema,
        },
        async (args) => {
          try {
            return compactResult(await adapter.edit(args as EditInput))
          } catch (error) {
            return failureResult(error)
          }
        }
      )
    ),
    tool('bash', (server) =>
      server.registerTool(
        'bash',
        {
          description:
            'Execute a PowerShell command in the workspace on Windows, or bash elsewhere. Returned stdout and stderr default to a combined 50,000-character limit.',
          inputSchema: z.strictObject({
            command: z.string(),
            timeout_ms: positiveInteger.optional(),
            max_output_chars: positiveInteger.max(1_000_000).optional(),
          }),
        },
        async (args) => {
          try {
            return compactResult(await adapter.bash(args as BashInput))
          } catch (error) {
            return failureResult(error)
          }
        }
      )
    ),
  ]
}
