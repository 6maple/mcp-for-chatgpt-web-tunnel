import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const serverEntry = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))

function parseTextResult(result) {
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')
  assert.equal('structuredContent' in result, false)
  return JSON.parse(result.content[0].text)
}

void test('MCP tools use compact responses, batching, partial reads, and output limits', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'mcp-perf-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'mcp-image-outside-'))
  await writeFile(join(workspace, 'a.txt'), 'one\ntwo\nthree\nfour')
  await writeFile(join(workspace, 'b.txt'), 'alpha\nbeta\ngamma')
  const pngBytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4DwUMMAYAj4IP8cvlVgcAAAAASUVORK5CYII=',
    'base64'
  )
  await writeFile(join(workspace, 'image.dat'), pngBytes)
  const outsideImagePath = join(outside, 'outside.png')
  await writeFile(outsideImagePath, pngBytes)

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, MCP_WORKSPACE_ROOT: workspace },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-server-test', version: '1.0.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'bash',
      'edit',
      'edit_many',
      'notify',
      'read',
      'read_image',
      'read_many',
      'write',
    ])

    const image = await client.callTool({ name: 'read_image', arguments: { path: 'image.dat' } })
    assert.equal(image.isError, undefined)
    assert.equal(image.content.length, 2)
    assert.equal(image.content[0].type, 'image')
    assert.equal(image.content[0].mimeType, 'image/png')
    assert.deepEqual(Buffer.from(image.content[0].data, 'base64'), pngBytes)
    assert.equal(image.content[1].type, 'text')
    const imageMetadata = JSON.parse(image.content[1].text)
    assert.equal(imageMetadata.mimeType, 'image/png')
    assert.equal(imageMetadata.compressed, false)
    assert.equal(imageMetadata.originalBytes, pngBytes.length)
    assert.equal(imageMetadata.bytes, pngBytes.length)
    assert.ok(imageMetadata.metrics.totalMs >= 0)
    assert.equal('structuredContent' in image, false)

    const absoluteImage = await client.callTool({
      name: 'read_image',
      arguments: { path: outsideImagePath },
    })
    assert.equal(absoluteImage.isError, undefined)
    assert.equal(absoluteImage.content[0].type, 'image')
    assert.equal(absoluteImage.content[0].mimeType, 'image/png')

    const partial = parseTextResult(
      await client.callTool({
        name: 'read',
        arguments: { path: 'a.txt', start_line: 2, line_count: 2 },
      })
    )
    assert.deepEqual(partial, {
      path: 'a.txt',
      content: 'two\nthree',
      start_line: 2,
      end_line: 3,
      total_lines: 4,
      truncated: true,
    })

    const throughEnd = parseTextResult(
      await client.callTool({
        name: 'read',
        arguments: { path: 'a.txt', start_line: 3, line_count: 10 },
      })
    )
    assert.deepEqual(throughEnd, {
      path: 'a.txt',
      content: 'three\nfour',
      start_line: 3,
      end_line: 4,
      total_lines: 4,
      truncated: true,
    })

    const defaultRead = parseTextResult(
      await client.callTool({ name: 'read', arguments: { path: 'b.txt' } })
    )
    assert.equal(defaultRead.content, 'alpha\nbeta\ngamma')
    assert.equal(defaultRead.end_line, 3)
    assert.equal(defaultRead.truncated, false)

    const limitedRead = parseTextResult(
      await client.callTool({
        name: 'read',
        arguments: { path: 'a.txt', max_chars: 5 },
      })
    )
    assert.equal(limitedRead.content, 'one\nt')
    assert.equal(limitedRead.truncated, true)

    const many = parseTextResult(
      await client.callTool({
        name: 'read_many',
        arguments: {
          files: [
            { path: 'a.txt', start_line: 1, line_count: 1 },
            { path: 'b.txt', start_line: 2, line_count: 1 },
          ],
        },
      })
    )
    assert.deepEqual(
      many.results.map((item) => [item.path, item.content]),
      [
        ['a.txt', 'one'],
        ['b.txt', 'beta'],
      ]
    )

    const edited = parseTextResult(
      await client.callTool({
        name: 'edit_many',
        arguments: {
          edits: [
            { path: 'a.txt', old_string: 'one', new_string: 'ONE' },
            { path: 'b.txt', old_string: 'beta', new_string: 'BETA' },
          ],
        },
      })
    )
    assert.equal(edited.results.length, 2)
    assert.equal(await readFile(join(workspace, 'a.txt'), 'utf8'), 'ONE\ntwo\nthree\nfour')
    assert.equal(await readFile(join(workspace, 'b.txt'), 'utf8'), 'alpha\nBETA\ngamma')

    const bash = parseTextResult(
      await client.callTool({
        name: 'bash',
        arguments: {
          command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(200))"`,
          max_output_chars: 80,
        },
      })
    )
    assert.deepEqual(Object.keys(bash).sort(), ['exit_code', 'stderr', 'stdout', 'truncated'])
    assert.equal(bash.exit_code, 0)
    assert.equal(bash.truncated, true)
    assert.ok(bash.stdout.length + bash.stderr.length <= 80)
  } finally {
    await client.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

void test('TOOLS_ENABLED exposes only the configured tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'mcp-enabled-tools-test-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      MCP_WORKSPACE_ROOT: workspace,
      TOOLS_ENABLED: ' read, write,edit,bash,read_image,read ',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'mcp-enabled-tools-test', version: '1.0.0' })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'bash',
      'edit',
      'read',
      'read_image',
      'write',
    ])
  } finally {
    await client.close().catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
  }
})
