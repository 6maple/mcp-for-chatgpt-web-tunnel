import { z } from 'zod'
import type { PiAdapter } from '@workspace/pi-adapter'
import type { ReadManyInput } from '@workspace/types'
import { compactResult, failureResult, type ToolRegistration } from '@workspace/mcp-tool-runtime'

const positiveInteger = z.number().int().positive()
const readInputSchema = z.strictObject({
  path: z.string(),
  start_line: positiveInteger.optional(),
  line_count: positiveInteger.max(1_000_000).optional(),
  max_chars: positiveInteger.max(1_000_000).optional(),
})
export function createReadManyTool(adapter: PiAdapter): ToolRegistration {
  return {
    name: 'read_many',
    register: (server) =>
      server.registerTool(
        'read_many',
        {
          description:
            'Read multiple workspace text files in one tool call. Each item supports the same start line, line count, and character limit as read.',
          inputSchema: z.strictObject({ files: z.array(readInputSchema).min(1).max(50) }),
        },
        async (args) => {
          try {
            return compactResult(await adapter.readMany(args as ReadManyInput))
          } catch (error) {
            return failureResult(error)
          }
        }
      ),
  }
}
