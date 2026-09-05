import type { PiAdapter } from '@workspace/pi-adapter'
import type { ToolRegistration } from '@workspace/mcp-tool-runtime'

export interface ExtraToolDependencies {
  workspaceRoot: string
  workspaceAllowed?: string
  adapter: PiAdapter
  windowsScriptSource: () => Promise<string>
}
export type ExtraToolLoader = (dependencies: ExtraToolDependencies) => Promise<ToolRegistration>
export const EXTRA_TOOL_LOADERS: Record<string, ExtraToolLoader> = {
  read_many: async ({ adapter }) => (await import('./read-many.js')).createReadManyTool(adapter),
  edit_many: async ({ adapter }) => (await import('./edit-many.js')).createEditManyTool(adapter),
  read_image: async ({ workspaceRoot, workspaceAllowed }) => {
    const [{ createImageAdapter }, { createReadImageTool }] = await Promise.all([
      import('@workspace/mcp-image-adapter'),
      import('./read-image.js'),
    ])
    return createReadImageTool(createImageAdapter(workspaceRoot, workspaceAllowed))
  },
  notify: async ({ windowsScriptSource }) => {
    const { createDesktopNotifier, createNotifyTool } = await import('./notify.js')
    return createNotifyTool(createDesktopNotifier(windowsScriptSource))
  },
}
