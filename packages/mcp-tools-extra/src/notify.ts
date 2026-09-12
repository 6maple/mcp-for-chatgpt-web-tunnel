import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import { compactResult, failureResult, type ToolRegistration } from '@workspace/mcp-tool-runtime'

const execFileAsync = promisify(execFile)
const DEFAULT_TITLE = 'ChatGPT'
const DEFAULT_MESSAGE = '任务已完成'
const notifyOutputSchema = z.strictObject({
  notified: z.literal(true),
  platform: z.enum(['macOS', 'Windows']),
  title: z.string(),
  message: z.string(),
})
export type WindowsScriptSource = () => Promise<string>
export interface NotificationCommand {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}
export type NotificationCommandRunner = (command: NotificationCommand) => Promise<void>
export interface DesktopNotifier {
  notify(input: {
    title?: string
    message?: string
  }): Promise<{ notified: true; platform: 'macOS' | 'Windows'; title: string; message: string }>
}
const normalize = (value: string | undefined, fallback: string, max: number) =>
  (value?.trim() || fallback).slice(0, max)
const defaultRunner: NotificationCommandRunner = async (input) => {
  await execFileAsync(input.command, input.args, {
    env: input.env,
    timeout: 10_000,
    windowsHide: true,
  })
}

export function createDesktopNotifier(
  windowsScriptSource: WindowsScriptSource,
  platform: NodeJS.Platform = process.platform,
  runCommand: NotificationCommandRunner = defaultRunner
): DesktopNotifier {
  return {
    async notify(input) {
      const title = normalize(input.title, DEFAULT_TITLE, 80)
      const message = normalize(input.message, DEFAULT_MESSAGE, 240)
      let command: NotificationCommand
      if (platform === 'darwin')
        command = {
          command: 'osascript',
          args: [
            '-e',
            'on run argv',
            '-e',
            'set notificationTitle to item 1 of argv',
            '-e',
            'set notificationMessage to item 2 of argv',
            '-e',
            'display notification notificationMessage with title notificationTitle',
            '-e',
            'end run',
            title,
            message,
          ],
        }
      else if (platform === 'win32')
        command = {
          command: 'powershell.exe',
          args: [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-EncodedCommand',
            Buffer.from(await windowsScriptSource(), 'utf16le').toString('base64'),
          ],
          env: { ...process.env, MCP_NOTIFY_TITLE: title, MCP_NOTIFY_MESSAGE: message },
        }
      else throw new Error(`desktop notifications are not supported on ${platform}`)
      await runCommand(command)
      return {
        notified: true,
        platform: platform === 'darwin' ? 'macOS' : 'Windows',
        title,
        message,
      }
    },
  }
}

export function createNotifyTool(notifier: DesktopNotifier): ToolRegistration {
  return {
    name: 'notify',
    register: (server) =>
      server.registerTool(
        'notify',
        {
          description:
            'Show a local desktop notification on macOS or Windows. Call this exactly once after the user task is fully complete, as the final tool call before the final answer.',
          inputSchema: z.strictObject({
            title: z.string().max(80).optional(),
            message: z.string().max(240).optional(),
          }),
          outputSchema: notifyOutputSchema,
          annotations: {
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
            readOnlyHint: false,
          },
        },
        async (args) => {
          try {
            return compactResult(await notifier.notify(args))
          } catch (error) {
            return failureResult(error)
          }
        }
      ),
  }
}
