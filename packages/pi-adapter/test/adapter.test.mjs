import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createPiAdapter } from '../dist/index.mjs'

void test('readMany preserves input order and validates line counts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'))
  try {
    await writeFile(join(workspace, 'one.txt'), 'a\nb\nc')
    await writeFile(join(workspace, 'two.txt'), 'd\ne\nf')
    const adapter = createPiAdapter(workspace)
    const result = await adapter.readMany({
      files: [
        { path: 'two.txt', start_line: 2, line_count: 1 },
        { path: 'one.txt', start_line: 1, line_count: 1 },
      ],
    })
    assert.deepEqual(
      result.results.map((item) => [item.path, item.content]),
      [
        ['two.txt', 'e'],
        ['one.txt', 'a'],
      ]
    )
    const throughEnd = await adapter.read({ path: 'one.txt', start_line: 2, line_count: 10 })
    assert.equal(throughEnd.content, 'b\nc')
    assert.equal(throughEnd.end_line, 3)
    assert.equal(throughEnd.truncated, true)

    const defaultRead = await adapter.read({ path: 'one.txt' })
    assert.equal(defaultRead.content, 'a\nb\nc')
    assert.equal(defaultRead.truncated, false)

    await assert.rejects(adapter.read({ path: 'one.txt', line_count: 0 }), /line_count/)
    await assert.rejects(adapter.read({ path: 'one.txt', start_line: 4 }), /exceeds total_lines/)
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

void test('supports absolute paths in any configured workspace root', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pi-adapter-roots-'))
  const first = join(parent, 'first')
  const second = join(parent, 'second')
  const outside = join(parent, 'outside')
  try {
    await Promise.all([
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ])
    await writeFile(join(second, 'two.txt'), 'second')
    await writeFile(join(outside, 'outside.txt'), 'outside')
    const adapter = createPiAdapter([first, second])
    const result = await adapter.read({ path: resolve(second, 'two.txt') })
    assert.equal(result.path, resolve(second, 'two.txt'))
    assert.equal(result.content, 'second')
    await assert.rejects(
      adapter.read({ path: resolve(outside, 'outside.txt') }),
      /configured workspaces/
    )
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
