import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_TITLE = 'ChatGPT'
const DEFAULT_MESSAGE = '任务已完成'
const MAX_TITLE_LENGTH = 80
const MAX_MESSAGE_LENGTH = 240

export interface NotifyInput {
  title?: string
  message?: string
}

export interface NotifyResult {
  notified: true
  platform: 'macOS' | 'Windows'
  title: string
  message: string
}

export interface NotificationCommand {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export type NotificationCommandRunner = (command: NotificationCommand) => Promise<void>

function normalizeText(value: string | undefined, fallback: string, maxLength: number): string {
  const normalized = value?.trim() || fallback
  return normalized.slice(0, maxLength)
}

function macOSCommand(title: string, message: string): NotificationCommand {
  return {
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
}

function windowsCommand(title: string, message: string): NotificationCommand {
  const script = `
$ErrorActionPreference = 'Stop'
$title = $env:MCP_NOTIFY_TITLE
$message = $env:MCP_NOTIFY_MESSAGE
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
  $escapedTitle = [System.Security.SecurityElement]::Escape($title)
  $escapedMessage = [System.Security.SecurityElement]::Escape($message)
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$escapedTitle</text><text>$escapedMessage</text></binding></visual></toast>")
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PowerShell').Show($toast)
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $notification = New-Object System.Windows.Forms.NotifyIcon
  $notification.Icon = [System.Drawing.SystemIcons]::Information
  $notification.BalloonTipTitle = $title
  $notification.BalloonTipText = $message
  $notification.Visible = $true
  $notification.ShowBalloonTip(5000)
  Start-Sleep -Milliseconds 5500
  $notification.Dispose()
}
`.trim()

  return {
    command: 'powershell.exe',
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    env: {
      ...process.env,
      MCP_NOTIFY_TITLE: title,
      MCP_NOTIFY_MESSAGE: message,
    },
  }
}

async function defaultRunner(input: NotificationCommand): Promise<void> {
  await execFileAsync(input.command, input.args, {
    env: input.env,
    timeout: 10_000,
    windowsHide: true,
  })
}

export interface DesktopNotifier {
  notify(input: NotifyInput): Promise<NotifyResult>
}

export function createDesktopNotifier(
  platform: NodeJS.Platform = process.platform,
  runCommand: NotificationCommandRunner = defaultRunner
): DesktopNotifier {
  return {
    async notify(input) {
      const title = normalizeText(input.title, DEFAULT_TITLE, MAX_TITLE_LENGTH)
      const message = normalizeText(input.message, DEFAULT_MESSAGE, MAX_MESSAGE_LENGTH)
      const command =
        platform === 'darwin'
          ? macOSCommand(title, message)
          : platform === 'win32'
            ? windowsCommand(title, message)
            : undefined

      if (!command) throw new Error(`desktop notifications are not supported on ${platform}`)
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
