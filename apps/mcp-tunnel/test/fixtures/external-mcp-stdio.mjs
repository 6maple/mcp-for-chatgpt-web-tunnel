#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

if (process.env.FIXTURE_PID_FILE) writeFileSync(process.env.FIXTURE_PID_FILE, String(process.pid))

const toolName = process.env.FIXTURE_TOOL_NAME ?? 'fixture_echo'
const resultPrefix = process.env.FIXTURE_RESULT_PREFIX ?? ''
const tool = {
  name: toolName,
  title: 'Fixture Echo',
  description: 'Echo back the provided text.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { $ref: '#/$defs/token' }, minItems: 1 },
        ],
      },
    },
    required: ['text'],
    additionalProperties: false,
    $defs: { token: { type: 'string', pattern: '^[a-z]+$' } },
  },
  outputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  annotations: {
    title: 'Fixture Echo Annotation',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { 'fixture/descriptor': 'preserved' },
}

const server = new Server(
  { name: 'external-mcp-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }))
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== toolName)
    return {
      isError: true,
      content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }],
    }
  const text = request.params.arguments?.text ?? ''
  if (text === '__protocol_error__')
    throw new Error('sensitive downstream fixture detail must not cross the gateway')
  if (text === '__tool_error__')
    return {
      isError: true,
      content: [{ type: 'text', text: 'controlled downstream tool failure' }],
      structuredContent: { text: 'tool-error' },
    }
  if (text === '__context__') {
    const context = JSON.stringify({ cwd: process.cwd(), value: process.env.FIXTURE_VALUE })
    return {
      content: [{ type: 'text', text: context }],
      structuredContent: { text: context },
    }
  }
  const renderedValue = Array.isArray(text)
    ? text.join(',')
    : typeof text === 'string'
      ? text
      : JSON.stringify(text)
  const rendered = resultPrefix + renderedValue
  return {
    content: [{ type: 'text', text: rendered }],
    structuredContent: { text: rendered },
    _meta: { 'fixture/result': 'preserved' },
  }
})

await server.connect(new StdioServerTransport())
