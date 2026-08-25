import { resolveWorkspaceRoot, startServer } from './server.js'
await startServer(resolveWorkspaceRoot())
