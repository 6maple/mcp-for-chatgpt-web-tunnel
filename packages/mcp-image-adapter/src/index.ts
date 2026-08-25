import { readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'
import { resolveExistingWorkspacePath } from '@workspace/pi-adapter'
import type { ReadImageInput, ReadImageResult, SupportedImageMimeType } from '@workspace/types'

const MAX_INPUT_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_TRANSMITTED_IMAGE_BYTES = 20 * 1024 * 1024
const AUTO_COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 2048
const WEBP_QUALITY = 85

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}
function detectImageMimeType(bytes: Buffer): SupportedImageMimeType | undefined {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)))
    return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

export interface ImageAdapter {
  readImage(input: ReadImageInput): Promise<ReadImageResult>
}

export function createImageAdapter(workspaceRoot: string): ImageAdapter {
  const root = resolve(workspaceRoot)
  return {
    async readImage(input) {
      const startedAt = performance.now()
      const resolveStartedAt = performance.now()
      if (typeof input.path !== 'string' || input.path.length === 0)
        throw new Error('path must be a non-empty string')
      const path = isAbsolute(input.path)
        ? await realpath(input.path)
        : await resolveExistingWorkspacePath(root, input.path)
      const metadata = await stat(path)
      const resolveMs = performance.now() - resolveStartedAt
      if (!metadata.isFile()) throw new Error('read_image: path must reference a file')
      if (metadata.size > MAX_INPUT_IMAGE_BYTES)
        throw new Error(
          `read_image: input exceeds the 100 MiB safety limit (${metadata.size} bytes)`
        )

      const readStartedAt = performance.now()
      const originalBytes = await readFile(path)
      const readMs = performance.now() - readStartedAt
      const originalMimeType = detectImageMimeType(originalBytes)
      if (!originalMimeType)
        throw new Error(
          'read_image: unsupported or unrecognized image format; expected PNG, JPEG, GIF, or WebP'
        )

      const inspectStartedAt = performance.now()
      let imageMetadata: { width?: number; height?: number }
      try {
        imageMetadata = await sharp(originalBytes, { pages: 1 }).metadata()
      } catch (error) {
        throw new Error(
          `read_image: failed to decode image: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      const inspectMs = performance.now() - inspectStartedAt
      const originalWidth = imageMetadata.width
      const originalHeight = imageMetadata.height
      const requiresResize =
        (originalWidth ?? 0) > MAX_IMAGE_DIMENSION || (originalHeight ?? 0) > MAX_IMAGE_DIMENSION
      const shouldCompress = requiresResize || originalBytes.length > AUTO_COMPRESS_THRESHOLD_BYTES
      let outputBytes = originalBytes
      let outputMimeType = originalMimeType
      let width = originalWidth
      let height = originalHeight
      let compressed = false
      let transformMs = 0
      if (shouldCompress) {
        const transformStartedAt = performance.now()
        let pipeline = sharp(originalBytes, { pages: 1 }).rotate()
        if (requiresResize)
          pipeline = pipeline.resize({
            width: MAX_IMAGE_DIMENSION,
            height: MAX_IMAGE_DIMENSION,
            fit: 'inside',
            withoutEnlargement: true,
          })
        const transformed = await pipeline
          .webp({ quality: WEBP_QUALITY, effort: 2 })
          .toBuffer({ resolveWithObject: true })
        transformMs = performance.now() - transformStartedAt
        if (requiresResize || transformed.data.length < originalBytes.length) {
          outputBytes = transformed.data
          outputMimeType = 'image/webp'
          width = transformed.info.width
          height = transformed.info.height
          compressed = true
        }
      }
      if (outputBytes.length > MAX_TRANSMITTED_IMAGE_BYTES)
        throw new Error(
          `read_image: optimized image still exceeds the 20 MiB transmission limit (${outputBytes.length} bytes)`
        )
      const base64StartedAt = performance.now()
      const data = outputBytes.toString('base64')
      const base64Ms = performance.now() - base64StartedAt
      return {
        path: isAbsolute(input.path) ? path : relative(root, path),
        data,
        mimeType: outputMimeType,
        bytes: outputBytes.length,
        originalBytes: originalBytes.length,
        originalWidth,
        originalHeight,
        width,
        height,
        compressed,
        metrics: {
          resolveMs: roundMs(resolveMs),
          readMs: roundMs(readMs),
          inspectMs: roundMs(inspectMs),
          transformMs: roundMs(transformMs),
          base64Ms: roundMs(base64Ms),
          totalMs: roundMs(performance.now() - startedAt),
        },
      }
    },
  }
}
