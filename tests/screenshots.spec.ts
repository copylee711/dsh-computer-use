import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { ScreenshotCache, collect, decodeFrames } from '../src/screenshots.js'

const zstdCompress = (zlib as unknown as { zstdCompressSync(data: Buffer): Buffer }).zstdCompressSync
const zstdDecompress = (zlib as unknown as { zstdDecompressSync(data: Uint8Array): Buffer }).zstdDecompressSync
const hex = (c: string) => c.repeat(64)
const A = hex('a'), B = hex('b'), C = hex('c'), D = hex('d')

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function home() {
  const root = await mkdtemp(join(tmpdir(), 'cu-shots-'))
  dirs.push(root)
  const objects = join(root, 'attachments', 'v1', 'objects')
  for (const id of [A, B, C, D]) {
    await mkdir(join(objects, id.slice(0, 2)), { recursive: true })
    await writeFile(join(objects, id.slice(0, 2), id), Buffer.alloc(1000))
  }
  return { root, objects, index: join(root, 'index.json') }
}

const result = (id: string) => JSON.stringify({ type: 'tool/result', data: { message: { content: [{ type: 'image', attachment: { attachmentId: `sha256:${id}`, mediaType: 'image/jpeg', bytes: 1000, width: 1356, height: 848, name: 'screenshot.jpg' } }] } } })

describe('screenshot cache', () => {
  it('only deletes screenshots no session references, and not brand-new ones', async () => {
    const { root, objects, index } = await home()
    // A: still referenced by a session (zstd log, two frames). B: our screenshot, session deleted, old.
    // C: our screenshot saved just now (grace period). D: not ours at all.
    await mkdir(join(root, 'sessions', 'ws', 'session-1'), { recursive: true })
    await writeFile(join(root, 'sessions', 'ws', 'session-1', 'session.v4.jsonl.zstd'), Buffer.concat([
      zstdCompress(Buffer.from(`${JSON.stringify({ type: 'session' })}\n`)),
      zstdCompress(Buffer.from(`${result(A)}\n`)),
    ]))
    await writeFile(index, JSON.stringify({ version: 1, screenshots: { [B]: Date.now() - 3 * 86_400_000, [C]: Date.now() } }))
    const cache = new ScreenshotCache(root, index)

    const before = await cache.stats()
    expect(before).toMatchObject({ count: 3, orphans: 1, orphanBytes: 1000 })

    expect(await cache.clean()).toEqual({ removed: 1, bytes: 1000 })
    const exists = async (id: string) => stat(join(objects, id.slice(0, 2), id)).then(() => true, () => false)
    expect(await exists(A)).toBe(true)
    expect(await exists(B)).toBe(false)
    expect(await exists(C)).toBe(true)
    expect(await exists(D)).toBe(true)
    const saved = JSON.parse(await readFile(index, 'utf8')) as { screenshots: Record<string, number> }
    expect(Object.keys(saved.screenshots).sort()).toEqual([A, C].sort()) // A learned from the session log
  })

  it('keeps everything when a session log cannot be read', async () => {
    const { root, objects, index } = await home()
    await mkdir(join(root, 'sessions', 'ws', 'session-1'), { recursive: true })
    await writeFile(join(root, 'sessions', 'ws', 'session-1', 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2, 3]))
    await writeFile(index, JSON.stringify({ version: 1, screenshots: { [B]: 1 } }))
    await expect(new ScreenshotCache(root, index).clean()).rejects.toThrow(/cleanup skipped/)
    expect(await stat(join(objects, B.slice(0, 2), B)).then(() => true)).toBe(true)
  })

  it('counts references from plugin stores such as the image gallery', async () => {
    const { root, index } = await home()
    await mkdir(join(root, 'storages', 'copylee-image-gen'), { recursive: true })
    await writeFile(join(root, 'storages', 'copylee-image-gen', 'gallery.json'), JSON.stringify({ items: [{ id: `sha256:${B}` }] }))
    await writeFile(index, JSON.stringify({ version: 1, screenshots: { [B]: 1 } }))
    expect(await new ScreenshotCache(root, index).clean()).toEqual({ removed: 0, bytes: 0 })
  })

  it('decodes multi-frame logs even when a magic number appears inside a frame', () => {
    const frames = Buffer.concat([zstdCompress(Buffer.from('one\n')), zstdCompress(Buffer.from('two\n'))])
    expect(decodeFrames(frames, zstdDecompress)).toBe('one\ntwo\n')
  })

  it('recognises our screenshots only in tool results', () => {
    const referenced = new Set<string>(), ours = new Set<string>()
    collect(`${result(A)}\n${JSON.stringify({ type: 'user/message', attachment: { attachmentId: `sha256:${B}`, name: 'screenshot.jpg' } })}`, referenced, ours)
    expect([...referenced].sort()).toEqual([A, B])
    expect([...ours]).toEqual([A])
  })
})
