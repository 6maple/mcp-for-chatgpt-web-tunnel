#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'external-mcp-duplicate-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } }
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'duplicate_fixture_tool', inputSchema: { type: 'object' } },
    { name: 'duplicate_fixture_tool', inputSchema: { type: 'object' } },
  ],
}))

await server.connect(new StdioServerTransport())
