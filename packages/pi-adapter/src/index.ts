import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, glob, readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  createBashTool,
  createEditTool,
  createWriteTool,
  type BashOperations,
} from '@earendil-works/pi-coding-agent'
import type {
  BashInput,
  BashResult,
  EditInput,
  EditManyInput,
  EditManyResult,
  EditResult,
  ReadInput,
  ReadManyInput,
  ReadManyResult,
  ReadResult,
  WriteInput,
  WriteResult,
} from '@workspace/types'

const DEFAULT_READ_MAX_CHARS = 50_000
const DEFAULT_BASH_MAX_OUTPUT_CHARS = 50_000
const MAX_RETURN_CHARS = 1_000_000

type PiResult = { content?: Array<{ type: string; text?: string }>; details?: unknown }

function textOf(result: PiResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n')
}

function normalizeWorkspaceRootPatterns(
  workspaceRoot: string,
  workspaceAllowed?: string | readonly string[]
): string[] {
  const allowed =
    typeof workspaceAllowed === 'string' ? workspaceAllowed.split(',') : (workspaceAllowed ?? [])
  const patterns = [workspaceRoot, ...allowed]
    .map((root) => root.trim())
    .filter(Boolean)
    .filter((root, index, values) => values.indexOf(root) === index)
  if (patterns.length === 0) throw new Error('at least one workspace root is required')
  return patterns
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

async function resolveWorkspaceRoots(patterns: readonly string[]): Promise<string[]> {
  const roots: string[] = []
  for (const pattern of patterns) {
    const matches: string[] = []
    if (/[*?[]/.test(pattern)) {
      for await (const match of glob(pattern)) matches.push(match)
    } else matches.push(pattern)
    for (const match of matches) {
      try {
        const path = resolve(match)
        if (!(await stat(path)).isDirectory()) continue
        if (!roots.includes(path)) roots.push(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return roots
}

async function assertInside(patterns: readonly string[], input: string): Promise<string> {
  if (typeof input !== 'string' || input.length === 0)
    throw new Error('path must be a non-empty string')
  const roots = await resolveWorkspaceRoots(patterns)
  if (roots.length === 0) throw new Error('no configured workspace currently exists')
  const target = isAbsolute(input) ? resolve(input) : resolve(roots[0]!, input)
  if (!roots.some((root) => isInside(root, target)))
    throw new Error('path must be inside one of the configured workspaces')
  return target
}

async function assertExistingPathInside(
  patterns: readonly string[],
  input: string
): Promise<string> {
  return assertInside(patterns, input)
}

function callId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  readMany(input: ReadManyInput): Promise<ReadManyResult>
  write(input: WriteInput): Promise<WriteResult>
  edit(input: EditInput): Promise<EditResult>
  editMany(input: EditManyInput): Promise<EditManyResult>
  bash(input: BashInput): Promise<BashResult>
}

/** Resolve a path while enforcing the configured lexical workspace boundary. */
export async function resolveExistingWorkspacePath(
  workspaceRoot: string,
  input: string,
  workspaceAllowed?: string | readonly string[]
): Promise<string> {
  return assertExistingPathInside(
    normalizeWorkspaceRootPatterns(workspaceRoot, workspaceAllowed),
    input
  )
}

export function createPiAdapter(
  workspaceRoot: string,
  workspaceAllowed?: string | readonly string[]
): PiAdapter {
  const patterns = normalizeWorkspaceRootPatterns(workspaceRoot, workspaceAllowed)
  const root = resolve(workspaceRoot)
  const windowsBash = process.platform === 'win32' ? powershellOperations() : undefined
  const bashTool = createBashTool(
    root,
    windowsBash ? { operations: windowsBash.operations } : undefined
  )
  const writeTool = createWriteTool(root)
  const editTool = createEditTool(root)

  const read = async (input: ReadInput): Promise<ReadResult> => {
    const path = await assertExistingPathInside(patterns, input.path)
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
      path: isAbsolute(input.path) ? path : relative(root, path),
      content,
      start_line: startLine,
      end_line: actualEndLine,
      total_lines: totalLines,
      truncated: startLine > 1 || endLine < totalLines || endedByCharacterLimit,
    }
  }

  const edit = async (input: EditInput): Promise<EditResult> => {
    const path = await assertExistingPathInside(patterns, input.path)
    await access(path, constants.R_OK | constants.W_OK)
    await editTool.execute(callId(), {
      path,
      edits: [{ oldText: input.old_string, newText: input.new_string }],
    })
    return { path: isAbsolute(input.path) ? path : relative(root, path), matches: 1 }
  }

  return {
    read,
    async readMany(input) {
      return { results: await Promise.all(input.files.map((file) => read(file))) }
    },
    async write(input) {
      const path = await assertInside(patterns, input.path)
      await writeTool.execute(callId(), { ...input, path })
      return {
        path: isAbsolute(input.path) ? path : relative(root, path),
        bytes: Buffer.byteLength(input.content, 'utf8'),
      }
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
