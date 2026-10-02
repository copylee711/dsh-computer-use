/**
 * Small HTTP bridge for the settings page: live status (helper, displays,
 * resulting screenshot size) and a short overlay preview.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { screenshotSize, type Display } from './coords.js'
import type { Settings } from './computer.js'
import type { HelperLike } from './helper-client.js'
import type { OverlayController } from './overlay.js'
import type { ScreenshotCache } from './screenshots.js'

export const STATUS_ROUTE = '/api/dsh-computer-use/status'
export const PREVIEW_ROUTE = '/api/dsh-computer-use/preview'
export const SCREENSHOTS_ROUTE = '/api/dsh-computer-use/screenshots'
export const SCREENSHOTS_CLEAN_ROUTE = '/api/dsh-computer-use/screenshots/clean'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export interface StatusBody {
  ok: true
  platform: string
  helper: 'ready' | 'error'
  error?: string
  displays: Array<Display & { shot: { width: number; height: number } }>
  controlling: boolean
}

export function statusRoute(helper: HelperLike, settings: () => Settings, overlay: OverlayController): Handler {
  return async (_req, res) => {
    const s = settings()
    try {
      const displays = await helper.call<Display[]>('displays', {}, 30_000)
      json(res, 200, {
        ok: true,
        platform: process.platform,
        helper: 'ready',
        displays: displays.map(d => ({ ...d, shot: screenshotSize(d, { maxLongEdge: s.maxLongEdge, maxPixels: s.maxPixels }) })),
        controlling: overlay.controller !== undefined,
      } satisfies StatusBody)
    } catch (error) {
      json(res, 200, { ok: true, platform: process.platform, helper: 'error', error: error instanceof Error ? error.message : String(error), displays: [], controlling: false } satisfies StatusBody)
    }
  }
}

/** Show the overlay for a few seconds so the user can see how it looks (skipped while an agent is controlling). */
export function previewRoute(helper: HelperLike, settings: () => Settings, overlay: OverlayController, iconPath: string): Handler {
  return async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return }
    if (overlay.controller !== undefined) { json(res, 409, { ok: false, error: 'busy' }); return }
    const s = settings()
    await helper.call('overlay_show', {
      label: `${s.overlayLabel} 正在操控你的电脑`, status: '预览 · 3 秒后消失', icon: iconPath, idleMs: s.userIdleMs, glow: s.overlay,
    })
    setTimeout(() => { if (overlay.controller === undefined) void helper.call('overlay_hide').catch(() => {}) }, 3000).unref()
    json(res, 200, { ok: true })
  }
}

/** Screenshot cache size and how much of it is orphaned. */
export function screenshotsRoute(cache: ScreenshotCache): Handler {
  return async (_req, res) => {
    try {
      json(res, 200, { ok: true, ...await cache.stats() })
    } catch (error) {
      json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Delete orphaned screenshots now. */
export function screenshotsCleanRoute(cache: ScreenshotCache): Handler {
  return async (req, res) => {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'POST only' }); return }
    try {
      const result = await cache.clean()
      json(res, 200, { ok: true, ...result, ...await cache.stats() })
    } catch (error) {
      json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
