import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { createImageAdapter } from '../dist/index.mjs'

void test('readImage remains sandboxed for relative paths and supports absolute images', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'image-adapter-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'image-adapter-outside-'))
  try {
    const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: 'white' } })
      .png()
      .toBuffer()
    await writeFile(join(workspace, 'image.png'), png)
    await writeFile(join(outside, 'outside.png'), png)
    await symlink(join(outside, 'outside.png'), join(workspace, 'escape.png'))
    const adapter = createImageAdapter(workspace)
    const image = await adapter.readImage({ path: 'image.png' })
    assert.equal(image.mimeType, 'image/png')
    assert.deepEqual(Buffer.from(image.data, 'base64'), png)
    const absolute = await adapter.readImage({ path: join(outside, 'outside.png') })
    assert.equal(absolute.path, await realpath(join(outside, 'outside.png')))
    await assert.rejects(adapter.readImage({ path: 'escape.png' }))
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
