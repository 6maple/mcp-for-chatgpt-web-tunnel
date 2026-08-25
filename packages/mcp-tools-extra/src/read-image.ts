import { z } from 'zod'
import type { ImageAdapter } from '@workspace/mcp-image-adapter'
import type { ReadImageInput } from '@workspace/types'
import { failureResult, type ToolRegistration } from '@workspace/mcp-tool-runtime'

export function createReadImageTool(adapter: ImageAdapter): ToolRegistration {
  return {
    name: 'read_image',
    register: (server) =>
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
            return failureResult(error)
          }
        }
      ),
  }
}
