import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  createBashTool,
  createEditTool,
  createWriteTool,
  type BashOperations,
} from '@earendil-works/pi-coding-agent'
import sharp from 'sharp'
import type {
  BashInput,
  BashResult,
  EditInput,
  EditManyInput,
  EditManyResult,
  EditResult,
  ReadImageInput,
  ReadImageResult,
  ReadInput,
  ReadManyInput,
  ReadManyResult,
  ReadResult,
  WriteInput,
  WriteResult,
  SupportedImageMimeType,
} from '@workspace/types'

const DEFAULT_READ_MAX_CHARS = 50_000
const MAX_INPUT_IMAGE_BYTES = 100 * 1024 * 1024
const MAX_TRANSMITTED_IMAGE_BYTES = 20 * 1024 * 1024
const AUTO_COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 2048
const WEBP_QUALITY = 85
const DEFAULT_BASH_MAX_OUTPUT_CHARS = 50_000
const MAX_RETURN_CHARS = 1_000_000

type PiResult = { content?: Array<{ type: string; text?: string }>; details?: unknown }

function textOf(result: PiResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n')
}

function assertInside(root: string, input: string): string {
  if (typeof input !== 'string' || input.length === 0)
    throw new Error('path must be a non-empty string')
  const target = resolve(root, input)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('path must be inside the workspace')
  return target
}

async function assertExistingPathInside(root: string, input: string): Promise<string> {
  const target = assertInside(root, input)
  try {
    const actual = await realpath(target)
    assertInside(await realpath(root), actual)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

async function resolveImageReadPath(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0)
    throw new Error('path must be a non-empty string')
  if (!isAbsolute(input)) return assertExistingPathInside(root, input)
  return realpath(input)
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

function callId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function detectImageMimeType(bytes: Buffer): SupportedImageMimeType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (bytes.length >= 6) {
    const signature = bytes.toString('ascii', 0, 6)
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

function boundedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value <= 0) throw new Error('limit must be a positive integer')
  return Math.min(value, MAX_RETURN_CHARS)
}

function truncateMiddle(value: string, maxChars: number): { value: string; truncated: boolean } {
  if (value.length <= maxChars) return { value, truncated: false }
  const marker = '\n... output truncated ...\n'
  if (maxChars <= marker.length) return { value: value.slice(0, maxChars), truncated: true }
  const available = maxChars - marker.length
  const headLength = Math.ceil(available / 2)
  const tailLength = Math.floor(available / 2)
  return {
    value: `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`,
    truncated: true,
  }
}

function limitCommandOutput(
  stdout: string,
  stderr: string,
  maxChars: number
): { stdout: string; stderr: string; truncated: boolean } {
  if (stdout.length + stderr.length <= maxChars) return { stdout, stderr, truncated: false }

  let stdoutBudget: number
  let stderrBudget: number
  const half = Math.floor(maxChars / 2)
  if (stdout.length <= half) {
    stdoutBudget = stdout.length
    stderrBudget = maxChars - stdoutBudget
  } else if (stderr.length <= half) {
    stderrBudget = stderr.length
    stdoutBudget = maxChars - stderrBudget
  } else {
    stdoutBudget = half
    stderrBudget = maxChars - half
  }

  const limitedStdout = truncateMiddle(stdout, stdoutBudget)
  const limitedStderr = truncateMiddle(stderr, stderrBudget)
  return {
    stdout: limitedStdout.value,
    stderr: limitedStderr.value,
    truncated: limitedStdout.truncated || limitedStderr.truncated,
  }
}

function powershellOperations(): {
  operations: BashOperations
  last: () => { stdout: string; stderr: string; exitCode: number | null }
} {
  let latest = { stdout: '', stderr: '', exitCode: null as number | null }
  return {
    operations: {
      exec: (command, cwd, options) =>
        new Promise((resolveExec, reject) => {
          let stdout = ''
          let stderr = ''
          const child = spawn(
            'powershell.exe',
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              command,
            ],
            {
              cwd,
              windowsHide: true,
              env: options.env,
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          )
          const timer =
            options.timeout === undefined
              ? undefined
              : setTimeout(() => child.kill(), options.timeout * 1000)
          child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8')
            options.onData(chunk)
          })
          child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8')
            options.onData(chunk)
          })
          const abort = () => child.kill()
          options.signal?.addEventListener('abort', abort, { once: true })
          child.on('error', reject)
          child.on('close', (exitCode) => {
            latest = { stdout, stderr, exitCode }
            if (timer) clearTimeout(timer)
            options.signal?.removeEventListener('abort', abort)
            if (options.signal?.aborted) reject(new Error('aborted'))
            else resolveExec({ exitCode })
          })
        }),
    },
    last: () => latest,
  }
}

export interface PiAdapter {
  read(input: ReadInput): Promise<ReadResult>
  readImage(input: ReadImageInput): Promise<ReadImageResult>
  readMany(input: ReadManyInput): Promise<ReadManyResult>
  write(input: WriteInput): Promise<WriteResult>
  edit(input: EditInput): Promise<EditResult>
  editMany(input: EditManyInput): Promise<EditManyResult>
  bash(input: BashInput): Promise<BashResult>
}

export function createPiAdapter(workspaceRoot: string): PiAdapter {
  const root = resolve(workspaceRoot)
  const windowsBash = process.platform === 'win32' ? powershellOperations() : undefined
  const bashTool = createBashTool(
    root,
    windowsBash ? { operations: windowsBash.operations } : undefined
  )
  const writeTool = createWriteTool(root)
  const editTool = createEditTool(root)

  const read = async (input: ReadInput): Promise<ReadResult> => {
    const path = await assertExistingPathInside(root, input.path)
    const source = await readFile(path, 'utf8')
    const lines = source.split('\n')
    const totalLines = lines.length
    const startLine = input.start_line ?? 1
    if (!Number.isInteger(startLine) || startLine <= 0)
      throw new Error('start_line must be a positive integer')
    if (startLine > totalLines)
      throw new Error(`start_line ${startLine} exceeds total_lines ${totalLines}`)
    const lineCount = input.line_count ?? totalLines - startLine + 1
    if (!Number.isInteger(lineCount) || lineCount <= 0)
      throw new Error('line_count must be a positive integer')

    const endLine = Math.min(startLine + lineCount - 1, totalLines)
    const selected = startLine > totalLines ? '' : lines.slice(startLine - 1, endLine).join('\n')
    const maxChars = boundedPositiveInteger(input.max_chars, DEFAULT_READ_MAX_CHARS)
    const content = selected.slice(0, maxChars)
    const endedByCharacterLimit = content.length < selected.length
    const actualEndLine =
      content.length === 0
        ? Math.min(startLine - 1, totalLines)
        : Math.min(startLine + (content.match(/\n/g)?.length ?? 0), endLine)

    return {
      path: relative(root, path),
      content,
      start_line: startLine,
      end_line: actualEndLine,
      total_lines: totalLines,
      truncated: startLine > 1 || endLine < totalLines || endedByCharacterLimit,
    }
  }

  const readImage = async (input: ReadImageInput): Promise<ReadImageResult> => {
    const startedAt = performance.now()

    const resolveStartedAt = performance.now()
    const path = await resolveImageReadPath(root, input.path)
    const fileMetadata = await stat(path)
    const resolveMs = performance.now() - resolveStartedAt

    if (!fileMetadata.isFile()) throw new Error('read_image: path must reference a file')
    if (fileMetadata.size > MAX_INPUT_IMAGE_BYTES)
      throw new Error(
        `read_image: input exceeds the 100 MiB safety limit (${fileMetadata.size} bytes)`
      )

    const readStartedAt = performance.now()
    const originalBytes = await readFile(path)
    const readMs = performance.now() - readStartedAt
    const originalMimeType = detectImageMimeType(originalBytes)
    if (originalMimeType === undefined)
      throw new Error(
        'read_image: unsupported or unrecognized image format; expected PNG, JPEG, GIF, or WebP'
      )

    const inspectStartedAt = performance.now()
    let imageMetadata
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
    const totalMs = performance.now() - startedAt

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
        totalMs: roundMs(totalMs),
      },
    }
  }

  const edit = async (input: EditInput): Promise<EditResult> => {
    const path = await assertExistingPathInside(root, input.path)
    await access(path, constants.R_OK | constants.W_OK)
    await editTool.execute(callId(), {
      path,
      edits: [{ oldText: input.old_string, newText: input.new_string }],
    })
    return { path: relative(root, path), matches: 1 }
  }

  return {
    read,
    readImage,
    async readMany(input) {
      return { results: await Promise.all(input.files.map((file) => read(file))) }
    },
    async write(input) {
      const path = assertInside(root, input.path)
      await writeTool.execute(callId(), { ...input, path })
      return { path: relative(root, path), bytes: Buffer.byteLength(input.content, 'utf8') }
    },
    edit,
    async editMany(input) {
      const results: EditResult[] = []
      for (const item of input.edits) results.push(await edit(item))
      return { results }
    },
    async bash(input) {
      if (typeof input.command !== 'string' || input.command.length === 0)
        throw new Error('command must be a non-empty string')
      const timeoutMs = Math.min(Math.max(Number(input.timeout_ms) || 120000, 1000), 600000)
      const maxOutputChars = boundedPositiveInteger(
        input.max_output_chars,
        DEFAULT_BASH_MAX_OUTPUT_CHARS
      )
      let exitCode: number | null = 0
      let stdout = ''
      let stderr = ''
      let adapterTruncated = false
      try {
        const result = (await bashTool.execute(callId(), {
          command: input.command,
          timeout: timeoutMs / 1000,
        })) as PiResult
        stdout = textOf(result)
        adapterTruncated = Boolean(
          (result.details as { truncation?: unknown } | undefined)?.truncation
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const match = message.match(/Command exited with code (\d+)/)
        const output = windowsBash?.last()
        exitCode = match ? Number(match[1]) : (output?.exitCode ?? null)
        stdout = output?.stdout ?? message
        stderr = output?.stderr ?? ''
      }
      const limited = limitCommandOutput(stdout, stderr, maxOutputChars)
      return {
        exit_code: exitCode,
        stdout: limited.stdout,
        stderr: limited.stderr,
        truncated: adapterTruncated || limited.truncated,
      }
    },
  }
}
