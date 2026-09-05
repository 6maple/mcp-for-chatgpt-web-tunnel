import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
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
    const adapter = createPiAdapter(first, second)
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

void test('re-evaluates glob workspace roots after startup', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pi-adapter-dynamic-glob-'))
  const first = join(parent, 'first')
  const projects = join(parent, 'projects')
  const project = join(projects, 'new-project')
  try {
    await Promise.all([mkdir(first, { recursive: true }), mkdir(projects, { recursive: true })])
    const adapter = createPiAdapter(first, join(projects, '*'))
    await mkdir(project, { recursive: true })
    await writeFile(join(project, 'notes.md'), 'created after adapter startup')
    const result = await adapter.read({ path: resolve(project, 'notes.md') })
    assert.equal(result.content, 'created after adapter startup')
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})

void test('keeps allowed symlink roots lexical', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pi-adapter-symlink-root-'))
  const root = join(parent, 'root')
  const allowed = join(parent, 'allowed')
  const outside = join(parent, 'outside')
  const linked = join(allowed, 'linked-project')
  try {
    await Promise.all([
      mkdir(root, { recursive: true }),
      mkdir(allowed, { recursive: true }),
      mkdir(outside, { recursive: true }),
    ])
    await writeFile(join(outside, 'notes.md'), 'linked')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const adapter = createPiAdapter(root, join(allowed, '*'))
    assert.equal((await adapter.read({ path: join(linked, 'notes.md') })).content, 'linked')
    await assert.rejects(adapter.read({ path: join(outside, 'notes.md') }), /configured workspaces/)
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
})
