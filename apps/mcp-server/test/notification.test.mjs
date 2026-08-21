import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesktopNotifier } from '../dist/notification.mjs'

void test('macOS notifier uses osascript without shell interpolation', async () => {
  const calls = []
  const notifier = createDesktopNotifier('darwin', async (command) => calls.push(command))
  const result = await notifier.notify({ title: 'Build', message: 'Done "successfully"' })

  assert.equal(result.platform, 'macOS')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'osascript')
  assert.equal(calls[0].args.at(-2), 'Build')
  assert.equal(calls[0].args.at(-1), 'Done "successfully"')
})

void test('Windows notifier uses an encoded PowerShell toast command', async () => {
  const calls = []
  const notifier = createDesktopNotifier('win32', async (command) => calls.push(command))
  const result = await notifier.notify({ title: 'ChatGPT', message: 'Task complete' })

  assert.equal(result.platform, 'Windows')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'powershell.exe')
  assert.equal(calls[0].env.MCP_NOTIFY_TITLE, 'ChatGPT')
  assert.equal(calls[0].env.MCP_NOTIFY_MESSAGE, 'Task complete')
  const encodedIndex = calls[0].args.indexOf('-EncodedCommand')
  assert.ok(encodedIndex >= 0)
  const script = Buffer.from(calls[0].args[encodedIndex + 1], 'base64').toString('utf16le')
  assert.match(script, /ToastNotificationManager/)
  assert.match(script, /SecurityElement/)
  assert.match(script, /NotifyIcon/)
})

void test('notifier trims defaults and rejects unsupported platforms', async () => {
  const calls = []
  const notifier = createDesktopNotifier('darwin', async (command) => calls.push(command))
  const result = await notifier.notify({ title: ' ', message: ' ' })
  assert.equal(result.title, 'ChatGPT')
  assert.equal(result.message, '任务已完成')

  const unsupported = createDesktopNotifier('linux', async () => undefined)
  await assert.rejects(unsupported.notify({}), /not supported/)
})
