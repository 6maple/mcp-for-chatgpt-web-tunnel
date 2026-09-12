import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export interface ToolRegistration {
  name: string
  register(server: McpServer): void
}

export function compactResult(value: object): {
  content: Array<{ type: 'text'; text: string }>
  structuredContent: Record<string, unknown>
} {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  }
}

export function failureResult(error: unknown): {
  isError: true
  content: Array<{ type: 'text'; text: string }>
} {
  return {
    isError: true,
    content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  }
}

export function parseEnabledToolNames(
  value: string | undefined,
  coreNames: readonly string[],
  extensionNames: readonly string[]
): ReadonlySet<string> {
  const available = [...coreNames, ...extensionNames]
  if (new Set(available).size !== available.length)
    throw new Error(`Duplicate tool name in registry: ${available.join(', ')}`)
  if (value === undefined) return new Set(coreNames)

  const requested = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const unknown = requested.filter((name) => !available.includes(name))
  if (unknown.length > 0)
    throw new Error(
      `Unknown tool name(s) in TOOLS_ENABLED: ${unknown.join(', ')}. Available tools: ${available.join(', ')}`
    )
  return new Set(requested)
}

export function registerSelectedTools(
  server: McpServer,
  registrations: readonly ToolRegistration[],
  enabled: ReadonlySet<string>
): void {
  const names = registrations.map((tool) => tool.name)
  if (new Set(names).size !== names.length)
    throw new Error(`Duplicate tool registration: ${names.join(', ')}`)
  for (const tool of registrations) if (enabled.has(tool.name)) tool.register(server)
}
