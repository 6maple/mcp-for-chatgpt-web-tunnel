import { z } from 'zod'
import type { ImageAdapter } from '@workspace/mcp-image-adapter'
import type { ReadImageInput } from '@workspace/types'
import { failureResult, type ToolRegistration } from '@workspace/mcp-tool-runtime'

const readImageOutputSchema = z.strictObject({
  path: z.string(),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  bytes: z.number().int().nonnegative(),
  originalBytes: z.number().int().nonnegative(),
  originalWidth: z.number().int().positive().optional(),
  originalHeight: z.number().int().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  compressed: z.boolean(),
  metrics: z.strictObject({
    resolveMs: z.number().nonnegative(),
    readMs: z.number().nonnegative(),
    inspectMs: z.number().nonnegative(),
    transformMs: z.number().nonnegative(),
    base64Ms: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  }),
})

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
          outputSchema: readImageOutputSchema,
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
              structuredContent: metadata,
            }
          } catch (error) {
            return failureResult(error)
          }
        }
      ),
  }
}
