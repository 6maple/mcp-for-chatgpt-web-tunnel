import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { BrainToolInvocation, BrainToolRegistrar } from 'brain/shared'

// Brain's public registry always registers an input schema and a two-argument callback.
type RegisterBrainTool = (
  name: string,
  config: Parameters<McpServer['registerTool']>[1],
  callback: (args: unknown, extra: unknown) => Promise<CallToolResult>
) => ReturnType<McpServer['registerTool']>

// ChatGPT provides conversation identity, but no documented turn identity.
// The explicit-restore contract calls brain_think once per new user message.
export function createBrainInvocation(sourceRoot: string) {
  function conversationId(extra: unknown): string {
    if (typeof extra !== 'object' || extra === null || !('_meta' in extra)) return ''
    const meta = extra._meta
    if (typeof meta !== 'object' || meta === null || !('openai/session' in meta)) return ''
    const session = meta['openai/session']
    return typeof session === 'string' && session.trim()
      ? createHash('sha256').update(session).digest('hex')
      : ''
  }

  function bindingPath(id: string) {
    return join(sourceRoot, '.brain-working', 'mcp-tunnel-invocations', `${id}.json`)
  }

  async function begin(extra: unknown) {
    const id = conversationId(extra)
    if (id) await rm(bindingPath(id), { force: true })
  }

  async function restored(extra: unknown) {
    const id = conversationId(extra)
    if (!id) return
    const file = bindingPath(id)
    const temporary = `${file}.${randomUUID()}.tmp`
    await mkdir(dirname(file), { recursive: true })
    try {
      await writeFile(temporary, JSON.stringify({ turnId: randomUUID() }), { flag: 'wx' })
      await rename(temporary, file)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  async function host(extra: unknown): Promise<NonNullable<BrainToolInvocation['stepHost']>> {
    const id = conversationId(extra)
    let turnId = ''
    if (id) {
      try {
        const stored: unknown = JSON.parse(await readFile(bindingPath(id), 'utf8'))
        if (
          typeof stored === 'object' &&
          stored !== null &&
          'turnId' in stored &&
          typeof stored.turnId === 'string'
        )
          turnId = stored.turnId
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return { conversationId: id, turnId, sourceRoot }
  }

  function registrar(server: BrainToolRegistrar): BrainToolRegistrar {
    const register = server.registerTool.bind(server) as RegisterBrainTool
    const registerTool: RegisterBrainTool = (name, config, callback) => {
      if (name !== 'brain_think' && name !== 'brain_step') return register(name, config, callback)
      return register(name, config, async (args, extra) => {
        try {
          if (name === 'brain_step') {
            const bound = await host(extra)
            if (!bound.conversationId)
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: 'brain_step 缺少宿主 openai/session；请修复连接的会话元数据。尚未初始化或修改 State。',
                  },
                ],
              }
            if (!bound.turnId)
              return {
                isError: true,
                content: [
                  {
                    type: 'text',
                    text: '本会话尚无成功的本轮恢复；先调用 brain_think，成功后再继续 brain_step。尚未初始化或修改 State。',
                  },
                ],
              }
            return callback(args, {
              ...(extra as Record<string, unknown>),
              _meta: {
                ...(extra as { _meta?: Record<string, unknown> })._meta,
                threadId: bound.conversationId,
                turnId: bound.turnId,
              },
            })
          }
          await begin(extra)
          const result = await callback(args, extra)
          if (!result.isError) await restored(extra)
          return result
        } catch {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: 'Brain 宿主轮次绑定未完成；排查本地存储后重新调用 brain_think，再继续 brain_step。尚未修改深度思考 State。',
              },
            ],
          }
        }
      })
    }
    return {
      registerTool: registerTool as BrainToolRegistrar['registerTool'],
    }
  }

  return { host, registrar }
}
