import { resolveWorkspaceRoots, startServer } from './server.js'
await startServer(await resolveWorkspaceRoots())
