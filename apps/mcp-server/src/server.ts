import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createPiAdapter, type PiAdapter } from '@workspace/pi-adapter'
import { createDesktopNotifier, type DesktopNotifier } from './notification.js'
import type {
  BashInput,
  EditInput,
  EditManyInput,
  ReadImageInput,
  ReadInput,
  ReadManyInput,
  WriteInput,
} from '@workspace/types'

function compactText(value: unknown): { type: 'text'; text: string } {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }
}

export function compactResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [compactText(value)] }
}

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

export const TOOL_NAMES = [
  'read',
  'read_image',
  'read_many',
  'write',
  'edit',
  'edit_many',
  'notify',
  'bash',
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES)

export function parseEnabledTools(value: string | undefined): ReadonlySet<ToolName> {
  if (value === undefined) return new Set(TOOL_NAMES)

  const requested = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const unknown = requested.filter((name) => !TOOL_NAME_SET.has(name))
  if (unknown.length > 0)
    throw new Error(
      `Unknown tool name(s) in TOOLS_ENABLED: ${unknown.join(', ')}. Available tools: ${TOOL_NAMES.join(', ')}`
    )

  return new Set(requested as ToolName[])
}

export function createServer(
  workspaceRoot: string,
  adapter: PiAdapter = createPiAdapter(workspaceRoot),
  notifier: DesktopNotifier = createDesktopNotifier(),
  enabledTools: ReadonlySet<ToolName> = new Set(TOOL_NAMES)
): McpServer {
  const server = new McpServer(
    { name: 'workspace-file-tools', version: '2.3.2' },
    enabledTools.has('notify')
      ? {
          instructions:
            'When a user task is fully complete, call the notify tool exactly once as the final tool call before returning the final answer. Do not notify for intermediate progress updates.',
        }
      : {}
  )
  const failure = (error: unknown) => ({
    isError: true,
    content: [
      { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
    ],
  })

  if (enabledTools.has('read'))
    server.registerTool(
      'read',
      {
        description:
          'Read a text file inside the workspace. start_line is 1-based; line_count limits how many lines are returned. Results default to at most 50,000 characters.',
        inputSchema: readInputSchema,
      },
      async (args) => {
        try {
          return compactResult(await adapter.read(args as ReadInput))
        } catch (error) {
          return failure(error)
        }
      }
    )
  if (enabledTools.has('read_image'))
    server.registerTool(
      'read_image',
      {
        description:
          'Read a PNG, JPEG, GIF, or WebP image. Relative paths stay inside the workspace; absolute paths can directly read local files. Large images are automatically resized/compressed before transmission, with timing metrics returned alongside the image.',
        inputSchema: z.strictObject({ path: z.string() }),
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
      },
      async (args) => {
        try {
          const image = await adapter.readImage(args as ReadImageInput)
          const { data, ...metadata } = image
          return {
            content: [
              { type: 'image' as const, data, mimeType: image.mimeType },
              { type: 'text' as const, text: JSON.stringify(metadata) },
            ],
          }
        } catch (error) {
          return failure(error)
        }
      }
    )
  if (enabledTools.has('read_many'))
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
          return failure(error)
        }
      }
    )
  if (enabledTools.has('write'))
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
          return failure(error)
        }
      }
    )
  if (enabledTools.has('edit'))
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
          return failure(error)
        }
      }
    )
  if (enabledTools.has('edit_many'))
    server.registerTool(
      'edit_many',
      {
        description: 'Apply multiple exact string replacements sequentially in one tool call.',
        inputSchema: z.strictObject({ edits: z.array(editInputSchema).min(1).max(50) }),
      },
      async (args) => {
        try {
          return compactResult(await adapter.editMany(args as EditManyInput))
        } catch (error) {
          return failure(error)
        }
      }
    )
  if (enabledTools.has('notify'))
    server.registerTool(
      'notify',
      {
        description:
          'Show a local desktop notification on macOS or Windows. Call this exactly once after the user task is fully complete, as the final tool call before the final answer.',
        inputSchema: z.strictObject({
          title: z.string().max(80).optional(),
          message: z.string().max(240).optional(),
        }),
        annotations: {
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
          readOnlyHint: false,
        },
      },
      async (args) => {
        try {
          return compactResult(await notifier.notify(args))
        } catch (error) {
          return failure(error)
        }
      }
    )
  if (enabledTools.has('bash'))
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
          return failure(error)
        }
      }
    )

  return server
}

export async function startServer(
  workspaceRoot: string,
  enabledTools: ReadonlySet<ToolName> = parseEnabledTools(process.env.TOOLS_ENABLED)
): Promise<void> {
  const server = createServer(workspaceRoot, undefined, undefined, enabledTools)
  await server.connect(new StdioServerTransport())
}
