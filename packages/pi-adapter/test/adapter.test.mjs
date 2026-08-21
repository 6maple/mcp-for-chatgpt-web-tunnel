import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
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

void test('readImage supports absolute paths, optimizes large images, reports timings, and keeps relative paths sandboxed', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pi-adapter-image-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'pi-adapter-image-outside-'))
  try {
    const pngBytes = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      },
    })
      .png()
      .toBuffer()
    const largePngBytes = await sharp({
      create: {
        width: 3200,
        height: 1800,
        channels: 3,
        background: { r: 120, g: 140, b: 160 },
      },
    })
      .png()
      .toBuffer()

    await writeFile(join(workspace, 'image.bin'), pngBytes)
    await writeFile(join(workspace, 'large.png'), largePngBytes)
    await writeFile(join(workspace, 'not-image.txt'), 'plain text')
    await writeFile(join(outside, 'outside.png'), pngBytes)
    await symlink(join(outside, 'outside.png'), join(workspace, 'escape.png'))
    const tooLargePath = join(workspace, 'too-large.png')
    await writeFile(tooLargePath, '')
    await truncate(tooLargePath, 100 * 1024 * 1024 + 1)

    const adapter = createPiAdapter(workspace)

    const image = await adapter.readImage({ path: 'image.bin' })
    assert.equal(image.mimeType, 'image/png')
    assert.equal(image.compressed, false)
    assert.equal(image.originalBytes, pngBytes.length)
    assert.equal(image.bytes, pngBytes.length)
    assert.equal(image.originalWidth, 8)
    assert.equal(image.originalHeight, 6)
    assert.equal(image.width, 8)
    assert.equal(image.height, 6)
    assert.deepEqual(Buffer.from(image.data, 'base64'), pngBytes)
    assert.ok(image.metrics.totalMs >= 0)
    assert.ok(image.metrics.readMs >= 0)
    assert.ok(image.metrics.inspectMs >= 0)

    const absolute = await adapter.readImage({ path: join(outside, 'outside.png') })
    assert.equal(absolute.path, await realpath(join(outside, 'outside.png')))
    assert.equal(absolute.mimeType, 'image/png')

    const large = await adapter.readImage({ path: 'large.png' })
    assert.equal(large.compressed, true)
    assert.equal(large.mimeType, 'image/webp')
    assert.equal(large.originalWidth, 3200)
    assert.equal(large.originalHeight, 1800)
    assert.ok((large.width ?? Infinity) <= 2048)
    assert.ok((large.height ?? Infinity) <= 2048)
    assert.ok(large.metrics.transformMs > 0)

    await assert.rejects(
      adapter.readImage({ path: 'not-image.txt' }),
      /unsupported or unrecognized/
    )
    await assert.rejects(adapter.readImage({ path: 'too-large.png' }), /100 MiB safety limit/)
    await assert.rejects(
      adapter.readImage({ path: 'escape.png' }),
      /path must be inside the workspace/
    )
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
