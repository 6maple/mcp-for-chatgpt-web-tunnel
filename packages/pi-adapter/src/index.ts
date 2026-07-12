import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type BashOperations,
} from '@earendil-works/pi-coding-agent'
import type {
  BashInput,
  BashResult,
  EditInput,
  EditResult,
  ReadInput,
  ReadResult,
  WriteInput,
  WriteResult,
} from '@workspace/types'

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

function callId(): string {
  return `mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  write(input: WriteInput): Promise<WriteResult>
  edit(input: EditInput): Promise<EditResult>
  bash(input: BashInput): Promise<BashResult>
}

export function createPiAdapter(workspaceRoot: string): PiAdapter {
  const root = resolve(workspaceRoot)
  const windowsBash = process.platform === 'win32' ? powershellOperations() : undefined
  const bashTool = createBashTool(
    root,
    windowsBash ? { operations: windowsBash.operations } : undefined
  )
  return {
    async read(input) {
      const path = await assertExistingPathInside(root, input.path)
      const result = (await createReadTool(root).execute(callId(), { ...input, path })) as PiResult
      return { path: relative(root, path), content: textOf(result) }
    },
    async write(input) {
      const path = assertInside(root, input.path)
      await createWriteTool(root).execute(callId(), { ...input, path })
      return { path: relative(root, path), bytes: Buffer.byteLength(input.content, 'utf8') }
    },
    async edit(input) {
      const path = await assertExistingPathInside(root, input.path)
      await access(path, constants.R_OK | constants.W_OK)
      await createEditTool(root).execute(callId(), {
        path,
        edits: [{ oldText: input.old_string, newText: input.new_string }],
      })
      return { path: relative(root, path), matches: 1 }
    },
    async bash(input) {
      if (typeof input.command !== 'string' || input.command.length === 0)
        throw new Error('command must be a non-empty string')
      const timeoutMs = Math.min(Math.max(Number(input.timeout_ms) || 120000, 1000), 600000)
      try {
        const result = (await bashTool.execute(callId(), {
          command: input.command,
          timeout: timeoutMs / 1000,
        })) as PiResult
        return {
          command: input.command,
          cwd: root,
          exit_code: 0,
          signal: null,
          stdout: textOf(result),
          stderr: '',
          truncated: Boolean((result.details as { truncation?: unknown } | undefined)?.truncation),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const match = message.match(/Command exited with code (\d+)/)
        const output = windowsBash?.last()
        return {
          command: input.command,
          cwd: root,
          exit_code: match ? Number(match[1]) : (output?.exitCode ?? null),
          signal: null,
          stdout: output?.stdout ?? message,
          stderr: output?.stderr ?? '',
          truncated: false,
        }
      }
    },
  }
}
