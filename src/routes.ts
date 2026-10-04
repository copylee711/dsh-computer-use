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
import type { SkillStore } from './skills.js'

export const STATUS_ROUTE = '/api/dsh-computer-use/status'
export const PREVIEW_ROUTE = '/api/dsh-computer-use/preview'
export const SCREENSHOTS_ROUTE = '/api/dsh-computer-use/screenshots'
export const SCREENSHOTS_CLEAN_ROUTE = '/api/dsh-computer-use/screenshots/clean'
export const SKILLS_ROUTE = '/api/dsh-computer-use/skills'

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
    // The same call the real thing makes, so the preview is what the saved settings show:
    // with the mini progress card, the card (and a sample of what scrolls through it) instead of the label bar.
    const pet = s.hostWindow === 'pet'
    await helper.call('overlay_show', {
      label: pet ? `${s.overlayLabel} 正在操控` : `${s.overlayLabel} 正在操控你的电脑`,
      status: pet ? '预览' : '预览 · 4 秒后消失',
      icon: iconPath, iconLight: iconPath.replace(/deepseek-white\.png$/, 'deepseek-black.png'),
      idleMs: s.userIdleMs, glow: s.overlay, pet, petOpacity: s.cardOpacity, text: '',
    })
    if (pet) {
      await helper.call('pet_update', {
        text: '这是预览：操控电脑时，这里滚动显示 AI 的回复正文。', thinking: '第二行显示思考过程和最近几步操作', steps: ['打开应用', '输入文字', '预览 · 4 秒后消失'], thinkingLatest: false,
      }).catch(() => {})
    }
    setTimeout(() => { if (overlay.controller === undefined) void helper.call('overlay_hide').catch(() => {}) }, 4000).unref()
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

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 200_000) throw new Error('request too large')
    chunks.push(chunk as Buffer)
  }
  const parsed: unknown = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))
  return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
}

/** App skills for the settings page: GET lists them; POST { op: 'save' | 'delete' | 'reset', ... } changes one. */
export function skillsRoute(skills: SkillStore): Handler {
  return async (req, res) => {
    if (req.method === 'POST') {
      const input = await body(req)
      const id = typeof input.id === 'string' ? input.id : ''
      try {
        if (input.op === 'delete') skills.remove(id)
        else if (input.op === 'reset') skills.reset(id)
        else if (input.op === 'save') {
          skills.save({
            app: String(input.app ?? ''),
            match: String(input.match ?? '').split(/[,，]/).map(item => item.trim()).filter(Boolean),
            summary: String(input.summary ?? ''),
            content: String(input.content ?? ''),
          }, id || undefined)
        } else { json(res, 400, { ok: false, error: 'unknown op' }); return }
      } catch (error) {
        json(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    json(res, 200, { ok: true, dir: skills.userDir, skills: skills.list() })
  }
}
