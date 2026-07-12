import { resolve } from 'node:path'
import { startServer } from './server.js'

await startServer(resolve(process.env.MCP_WORKSPACE_ROOT ?? process.cwd()))
