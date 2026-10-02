/**
 * Screenshot cache housekeeping. Every screenshot is an image attachment in
 * DeepSeek Harness's content-addressed store (<DSH_HOME>/attachments/v1/objects/<2>/<sha256>),
 * which has no retention policy yet. Attachments still referenced by a session
 * must stay byte-for-byte (DSH verifies their hash, and a missing one fails the
 * whole turn), so only orphans are removed: screenshots this plugin made that
 * no session, archive or plugin store references any more (e.g. the session
 * was deleted).
 */
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as zlib from 'node:zlib'

const HEX = /^[0-9a-f]{64}$/
/** Newly saved screenshots may not be in a session log yet. */
const GRACE_MS = 24 * 60 * 60_000
/** Places outside the session logs that can reference attachments. */
const OTHER_REFERENCE_DIRS = ['storages', 'rewind-snapshots', 'dsh-session-archive', 'task-board']
const MAX_SCANNED_FILE = 64 * 1024 * 1024

export interface ScreenshotStats {
  /** Screenshots this plugin knows about that still exist on disk. */
  count: number
  bytes: number
  /** Of those, the ones no longer referenced anywhere (safe to delete). */
  orphans: number
  orphanBytes: number
}

export interface CleanResult {
  removed: number
  bytes: number
}

interface Scan {
  referenced: Set<string>
  /** Screenshots found in tool results of existing sessions (made before the index existed). */
  ours: Set<string>
}

type ZstdDecompress = (data: Uint8Array) => Buffer

export class ScreenshotCache {
  private index: Map<string, number> | undefined
  private saving: Promise<void> = Promise.resolve()
  private busy: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dshHome = process.env.DSH_HOME || join(homedir(), '.dsh'),
    private readonly indexFile = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dsh-computer-use', 'screenshots.json'),
    private readonly log: (message: string) => void = () => {},
  ) {}

  private get objects(): string {
    return join(this.dshHome, 'attachments', 'v1', 'objects')
  }

  private path(hex: string): string {
    return join(this.objects, hex.slice(0, 2), hex)
  }

  /** Remember a screenshot attachment ("sha256:<hex>") this plugin saved. */
  record(attachmentId: string): void {
    const hex = attachmentId.replace(/^sha256:/, '')
    if (!HEX.test(hex)) return
    void this.load().then(index => {
      index.set(hex, Date.now())
      this.persist()
    }).catch(() => {})
  }

  async stats(): Promise<ScreenshotStats> {
    return this.exclusive(async () => {
      const { candidates, orphans } = await this.classify()
      const sizes = await Promise.all([...candidates].map(hex => this.size(hex)))
      let count = 0, bytes = 0, orphanCount = 0, orphanBytes = 0
      ;[...candidates].forEach((hex, i) => {
        const size = sizes[i]
        if (size === undefined) return
        count++
        bytes += size
        if (orphans.has(hex)) { orphanCount++; orphanBytes += size }
      })
      return { count, bytes, orphans: orphanCount, orphanBytes }
    })
  }

  /** Delete orphaned screenshots. */
  async clean(): Promise<CleanResult> {
    return this.exclusive(async () => {
      const { orphans } = await this.classify()
      const index = await this.load()
      let removed = 0, bytes = 0
      for (const hex of orphans) {
        const size = await this.size(hex)
        if (size !== undefined) {
          try {
            const file = this.path(hex)
            await chmod(file, 0o666).catch(() => {}) // the store writes objects read-only
            await unlink(file)
            removed++
            bytes += size
          } catch (error) {
            this.log(`screenshot cleanup: ${String(error)}`)
            continue
          }
        }
        index.delete(hex)
      }
      this.persist()
      await this.saving
      if (removed > 0) this.log(`screenshot cleanup: removed ${removed} orphaned screenshots (${(bytes / 1048576).toFixed(1)} MB)`)
      return { removed, bytes }
    })
  }

  // ------------------------------------------------------------- internals

  private async classify(): Promise<{ candidates: Set<string>; orphans: Set<string> }> {
    const index = await this.load()
    const scan = await this.scan()
    // Screenshots seen in session logs join the index, so they are recognised once their session is gone.
    let added = false
    for (const hex of scan.ours) {
      if (!index.has(hex)) { index.set(hex, 0); added = true }
    }
    if (added) this.persist()
    const now = Date.now()
    const candidates = new Set(index.keys())
    const orphans = new Set<string>()
    for (const [hex, savedAt] of index) {
      if (scan.referenced.has(hex)) continue
      if (savedAt > 0 && now - savedAt < GRACE_MS) continue
      orphans.add(hex)
    }
    return { candidates, orphans }
  }

  /** Every attachment id referenced anywhere DSH keeps conversation state. */
  private async scan(): Promise<Scan> {
    const zstd = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync
    if (typeof zstd !== 'function') throw new Error('This runtime cannot read DeepSeek Harness session logs (no zstd); cleanup skipped.')
    const referenced = new Set<string>()
    const ours = new Set<string>()
    const sessions = join(this.dshHome, 'sessions')
    for (const file of await walk(sessions)) {
      const text = await readText(file, zstd)
      if (text === undefined) throw new Error(`Could not read ${file}; cleanup skipped to stay safe.`)
      collect(text, referenced, ours)
    }
    for (const dir of OTHER_REFERENCE_DIRS) {
      for (const file of await walk(join(this.dshHome, dir))) {
        const text = await readText(file, zstd)
        if (text !== undefined) collect(text, referenced, ours)
      }
    }
    return { referenced, ours }
  }

  private async size(hex: string): Promise<number | undefined> {
    try { return (await stat(this.path(hex))).size } catch { return undefined }
  }

  private async load(): Promise<Map<string, number>> {
    if (this.index) return this.index
    try {
      const raw = JSON.parse(await readFile(this.indexFile, 'utf8')) as { screenshots?: Record<string, number> }
      this.index = new Map(Object.entries(raw.screenshots ?? {}).filter(([hex]) => HEX.test(hex)))
    } catch {
      this.index = new Map()
    }
    return this.index
  }

  private persist(): void {
    const index = this.index
    if (!index) return
    this.saving = this.saving.then(async () => {
      await mkdir(join(this.indexFile, '..'), { recursive: true })
      const tmp = `${this.indexFile}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify({ version: 1, screenshots: Object.fromEntries(index) }))
      await rename(tmp, this.indexFile)
    }).catch(error => this.log(`screenshot index: ${String(error)}`))
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.busy.then(task, task)
    this.busy = run.catch(() => {})
    return run
  }
}

/** Ids in `text`; ids of our own screenshots (tool results named screenshot.jpg) also go to `ours`. */
export function collect(text: string, referenced: Set<string>, ours: Set<string>): void {
  for (const match of text.matchAll(/sha256:([0-9a-f]{64})/g)) referenced.add(match[1]!)
  for (const line of text.split('\n')) {
    if (!line.includes('"tool/result"') || !line.includes('"screenshot.jpg"')) continue
    for (const match of line.matchAll(/"attachmentId":"sha256:([0-9a-f]{64})"[^{}]*?"name":"screenshot\.jpg"/g)) ours.add(match[1]!)
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** File text; zstd logs are a sequence of frames (decoded one by one). */
async function readText(file: string, zstd: ZstdDecompress): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_SCANNED_FILE) return ''
    const data = await readFile(file)
    if (!file.endsWith('.zstd')) return data.toString('utf8')
    return decodeFrames(data, zstd)
  } catch {
    return undefined
  }
}

/** Split at frame magics; when a split falls inside a frame, merge with the next piece and retry. */
export function decodeFrames(data: Buffer, zstd: ZstdDecompress): string | undefined {
  const starts: number[] = []
  for (let i = data.indexOf(ZSTD_MAGIC); i >= 0; i = data.indexOf(ZSTD_MAGIC, i + 1)) starts.push(i)
  if (starts.length === 0) return data.length === 0 ? '' : undefined
  const parts: Buffer[] = []
  let from = 0
  while (from < starts.length) {
    let decoded: Buffer | undefined
    let to = from + 1
    for (; to <= starts.length; to++) {
      try {
        decoded = zstd(data.subarray(starts[from]!, starts[to] ?? data.length))
        break
      } catch { /* the next magic was inside this frame */ }
    }
    if (decoded === undefined) return undefined
    parts.push(decoded)
    from = to
  }
  return Buffer.concat(parts).toString('utf8')
}
