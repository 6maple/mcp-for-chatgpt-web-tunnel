import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * Generic downstream MCP server manifest and client lifecycle for the Tunnel.
 * Stdio servers use `command / args / env / cwd`; Streamable HTTP servers use
 * `url / headers`.
 */

export const EXTERNAL_MCP_CONFIG_ENV = 'MCP_EXTERNAL_MCP_FILE'
const EXTERNAL_MCP_CLIENT_NAME = 'mcp-tunnel-external-gateway'
const EXTERNAL_MCP_CLIENT_VERSION = '1.0.0'

const STDIO_FIELDS = ['command', 'args', 'env', 'cwd'] as const
const STREAMABLE_HTTP_FIELDS = ['url', 'headers'] as const

export interface ExternalMcpStdioConfig {
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
}

export interface ExternalMcpStreamableHttpConfig {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export type ExternalMcpServerConfig = ExternalMcpStdioConfig | ExternalMcpStreamableHttpConfig
export type ExternalMcpConfig = Readonly<Record<string, ExternalMcpServerConfig>>

export interface ExternalMcpServerEntry {
  readonly name: string
  readonly config: ExternalMcpServerConfig
  /** Connected client; `connect()` already completed MCP initialization. */
  readonly client: Client
  readonly transport: Transport
  /** Standard MCP descriptors discovered from every page of `tools/list`. */
  readonly tools: readonly Tool[]
}

export interface ExternalMcpRegistry {
  readonly servers: readonly ExternalMcpServerEntry[]
  readonly size: number
  readonly closed: boolean
  close(): Promise<void>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string')
}

function unknownFields(entry: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(entry).filter((key) => !allowed.includes(key))
}

function parseStdioConfig(name: string, entry: Record<string, unknown>): ExternalMcpStdioConfig {
  const unknown = unknownFields(entry, STDIO_FIELDS)
  if (unknown.length > 0)
    throw new Error(
      `External MCP server "${name}" has unknown field(s) ${unknown.map((key) => `"${key}"`).join(', ')}: stdio servers only support ${STDIO_FIELDS.map((key) => `"${key}"`).join(', ')}`
    )
  const { command, args, env, cwd } = entry
  if (typeof command !== 'string' || command.trim().length === 0)
    throw new Error(`External MCP server "${name}" must configure a non-empty "command"`)
  if (
    args !== undefined &&
    (!Array.isArray(args) || !args.every((item) => typeof item === 'string'))
  )
    throw new Error(`External MCP server "${name}" must configure "args" as an array of strings`)
  if (env !== undefined && !isStringRecord(env))
    throw new Error(
      `External MCP server "${name}" must configure "env" as an object of string values`
    )
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim().length === 0))
    throw new Error(`External MCP server "${name}" must configure "cwd" as a non-empty string`)
  return {
    command,
    ...(args === undefined ? {} : { args: [...args] as string[] }),
    ...(env === undefined ? {} : { env: { ...(env as Record<string, string>) } }),
    ...(cwd === undefined ? {} : { cwd: cwd as string }),
  }
}

function parseStreamableHttpConfig(
  name: string,
  entry: Record<string, unknown>
): ExternalMcpStreamableHttpConfig {
  const unknown = unknownFields(entry, STREAMABLE_HTTP_FIELDS)
  if (unknown.length > 0)
    throw new Error(
      `External MCP server "${name}" has unknown field(s) ${unknown.map((key) => `"${key}"`).join(', ')}: Streamable HTTP servers only support ${STREAMABLE_HTTP_FIELDS.map((key) => `"${key}"`).join(', ')}`
    )
  const { url, headers } = entry
  if (typeof url !== 'string' || url.trim().length === 0)
    throw new Error(`External MCP server "${name}" must configure a non-empty "url"`)
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error(`External MCP server "${name}" must configure a valid absolute "url"`)
  }
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new Error(`External MCP server "${name}" must configure an http(s) "url"`)
  if (headers !== undefined && !isStringRecord(headers))
    throw new Error(
      `External MCP server "${name}" must configure "headers" as an object of string values`
    )
  return {
    url,
    ...(headers === undefined ? {} : { headers: { ...(headers as Record<string, string>) } }),
  }
}

/** Strictly parse a standard `{ "mcpServers": { ... } }` manifest. */
export function parseExternalMcpConfig(raw: unknown): ExternalMcpConfig {
  if (!isPlainObject(raw))
    throw new Error('External MCP config must be an object with a "mcpServers" property')
  const topUnknown = unknownFields(raw, ['mcpServers'])
  if (topUnknown.length > 0)
    throw new Error(
      `External MCP config has unknown field(s) ${topUnknown.map((key) => `"${key}"`).join(', ')}: only "mcpServers" is supported`
    )
  const { mcpServers } = raw
  if (!isPlainObject(mcpServers))
    throw new Error('External MCP config must contain a "mcpServers" object')

  const parsed: Record<string, ExternalMcpServerConfig> = {}
  for (const [name, value] of Object.entries(mcpServers)) {
    if (name.trim().length === 0) throw new Error('External MCP server name must not be empty')
    if (!isPlainObject(value)) throw new Error(`External MCP server "${name}" must be an object`)
    const hasCommand = 'command' in value
    const hasUrl = 'url' in value
    if (hasCommand && hasUrl)
      throw new Error(
        `External MCP server "${name}" must not mix stdio ("command") and Streamable HTTP ("url") fields`
      )
    if (hasCommand) parsed[name] = parseStdioConfig(name, value)
    else if (hasUrl) parsed[name] = parseStreamableHttpConfig(name, value)
    else
      throw new Error(
        `External MCP server "${name}" must configure either stdio ("command") or Streamable HTTP ("url")`
      )
  }
  return parsed
}

function resolveUserPath(value: string): string {
  const trimmed = value.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
    return resolve(homedir(), trimmed.slice(2))
  return resolve(trimmed)
}

/** An unset or blank path disables the external gateway. */
export function resolveExternalMcpConfigPath(
  value: string | undefined = process.env[EXTERNAL_MCP_CONFIG_ENV]
): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

export async function loadExternalMcpConfigFile(configPath: string): Promise<ExternalMcpConfig> {
  const filename = resolveUserPath(configPath)
  let content: string
  try {
    content = await readFile(filename, 'utf8')
  } catch (error) {
    throw new Error(
      `Failed to load external MCP config from "${filename}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
  try {
    return parseExternalMcpConfig(JSON.parse(content))
  } catch (error) {
    throw new Error(
      `Failed to parse external MCP config from "${filename}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function validateDiscoveredTools(serverName: string, tools: readonly Tool[]): void {
  const names = new Set<string>()
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name.length === 0)
      throw new Error(`External MCP server "${serverName}" returned a tool with an empty name`)
    if (names.has(tool.name))
      throw new Error(
        `Duplicate tool "${tool.name}" discovered from external MCP server "${serverName}"`
      )
    names.add(tool.name)
  }
}

function createStdioTransport(config: ExternalMcpStdioConfig): StdioClientTransport {
  return new StdioClientTransport({
    command: config.command,
    args: config.args === undefined ? [] : [...config.args],
    env: { ...getDefaultEnvironment(), ...config.env },
    ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
    stderr: 'ignore',
  })
}

function createStreamableHttpTransport(
  config: ExternalMcpStreamableHttpConfig
): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(
    new URL(config.url),
    config.headers === undefined ? undefined : { requestInit: { headers: { ...config.headers } } }
  )
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return tools
}

async function connectOneServer(
  name: string,
  config: ExternalMcpServerConfig
): Promise<ExternalMcpServerEntry> {
  const transport =
    'command' in config ? createStdioTransport(config) : createStreamableHttpTransport(config)
  const client = new Client({
    name: EXTERNAL_MCP_CLIENT_NAME,
    version: EXTERNAL_MCP_CLIENT_VERSION,
  })
  try {
    await client.connect(transport)
    const tools = await listAllTools(client)
    validateDiscoveredTools(name, tools)
    return { name, config, client, transport, tools }
  } catch (error) {
    if (transport instanceof StreamableHTTPClientTransport) {
      try {
        await transport.terminateSession()
      } catch {
        // Best effort during failure cleanup.
      }
    }
    try {
      await client.close()
    } catch {
      // Best effort during failure cleanup.
    }
    throw new Error(
      `Failed to connect external MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

async function closeEntryClient(entry: ExternalMcpServerEntry): Promise<void> {
  if (entry.transport instanceof StreamableHTTPClientTransport) {
    try {
      await entry.transport.terminateSession()
    } catch {
      // Closing the transport below still releases the session locally.
    }
  }
  try {
    await entry.client.close()
  } catch {
    // Cleanup is best effort and remains idempotent.
  }
}

/** Connect and discover every configured server, closing all peers if one fails. */
export async function connectExternalMcpRegistry(
  config: ExternalMcpConfig
): Promise<ExternalMcpRegistry> {
  const connected: ExternalMcpServerEntry[] = []
  try {
    for (const [name, serverConfig] of Object.entries(config))
      connected.push(await connectOneServer(name, serverConfig))
  } catch (error) {
    for (const entry of [...connected].reverse()) await closeEntryClient(entry)
    throw error
  }

  let closed = false
  let closing: Promise<void> | undefined
  const close = async (): Promise<void> => {
    if (closing !== undefined) return closing
    closing = (async () => {
      closed = true
      for (const entry of [...connected].reverse()) await closeEntryClient(entry)
    })()
    return closing
  }
  return {
    servers: [...connected],
    get size() {
      return connected.length
    },
    get closed() {
      return closed
    },
    close,
  }
}

export async function loadAndConnectExternalMcpRegistry(
  configPath: string | undefined = resolveExternalMcpConfigPath()
): Promise<ExternalMcpRegistry> {
  if (configPath === undefined) return connectExternalMcpRegistry({})
  return connectExternalMcpRegistry(await loadExternalMcpConfigFile(configPath))
}
