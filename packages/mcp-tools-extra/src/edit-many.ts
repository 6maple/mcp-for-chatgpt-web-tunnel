import { z } from 'zod'
import type { PiAdapter } from '@workspace/pi-adapter'
import type { EditManyInput } from '@workspace/types'
import { compactResult, failureResult, type ToolRegistration } from '@workspace/mcp-tool-runtime'

const editInputSchema = z.strictObject({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
})
export function createEditManyTool(adapter: PiAdapter): ToolRegistration {
  return {
    name: 'edit_many',
    register: (server) =>
      server.registerTool(
        'edit_many',
        {
          description:
            'Apply multiple exact string replacements sequentially in one tool call. This operation is not atomic: earlier edits remain if a later edit fails.',
          inputSchema: z.strictObject({ edits: z.array(editInputSchema).min(1).max(50) }),
        },
        async (args) => {
          try {
            return compactResult(await adapter.editMany(args as EditManyInput))
          } catch (error) {
            return failureResult(error)
          }
        }
      ),
  }
}
