/**
 * @copylee/dsh-computer-use host bundle: Claude-style computer use for the
 * Windows desktop — screenshots in, mouse and keyboard out, per-app grants
 * through DSH approvals, and an orange "DeepSeek is using your computer"
 * overlay that a physical Esc dismisses.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from './system-prompt-service.js'
import { AccessControl, normalizeApp, type AccessMode } from './access.js'
import { Computer, type CallContext, type Settings } from './computer.js'
import { HelperClient } from './helper-client.js'
import { OverlayController, type CancellableAgent } from './overlay.js'
import { promptText } from './prompt.js'
import { createTools } from './tools.js'

export const name = '@copylee/dsh-computer-use'
export const inject = ['tools', 'attachments']

export interface Config {
  accessMode?: AccessMode
  overlay?: boolean
  overlayLabel?: string
  minimizeHostWindow?: boolean
  autoScreenshot?: boolean
  settleMs?: number
  maxLongEdge?: number
  maxPixels?: number
  jpegQuality?: number
  blockedApps?: string[]
}

const DEFAULTS: Settings = {
  accessMode: 'per-app',
  overlay: true,
  overlayLabel: 'DeepSeek',
  minimizeHostWindow: false,
  autoScreenshot: true,
  settleMs: 400,
  maxLongEdge: 1366,
  maxPixels: 1_150_000,
  jpegQuality: 80,
  blockedApps: [],
}

export const Config: z<Config> = z.object({
  accessMode: z.union([
    z.const('per-app').i18n({ 'zh-CN': { $description: '按应用授权（每个会话由你批准要操控的应用）' }, 'en-US': { $description: 'Per app (approve the apps each session)' } }),
    z.const('allow-all').i18n({ 'zh-CN': { $description: '全部允许（不弹审批）' }, 'en-US': { $description: 'Allow all apps (no approval)' } }),
  ]).default('per-app').volatile().i18n({
    'zh-CN': { $description: '授权方式。无论哪种，DeepSeek Harness 自身窗口和下方“禁止操控的应用”都不会被操作。' },
    'en-US': { $description: 'Access mode. DeepSeek Harness itself and blocked apps are never controlled.' },
  }),
  overlay: z.boolean().default(true).volatile().i18n({
    'zh-CN': { $description: '控制时显示橙色光晕边框和顶部提示条（不会出现在截图里，按 Esc 可停止）' },
    'en-US': { $description: 'Show the orange glow and status pill while controlling (hidden from screenshots; Esc stops)' },
  }),
  overlayLabel: z.string().default('DeepSeek').volatile().i18n({
    'zh-CN': { $description: '提示条名称：“<名称> 正在使用你的电脑”' },
    'en-US': { $description: 'Name in the pill: "<name> 正在使用你的电脑"' },
  }),
  minimizeHostWindow: z.boolean().default(false).volatile().i18n({
    'zh-CN': { $description: '控制期间最小化 DeepSeek Harness 窗口，结束后恢复' },
    'en-US': { $description: 'Minimize the DeepSeek Harness window while controlling; restore afterwards' },
  }),
  autoScreenshot: z.boolean().default(true).volatile().i18n({
    'zh-CN': { $description: '每次操作后自动回传截图（省去一轮调用）' },
    'en-US': { $description: 'Return a screenshot after every action (saves a round trip)' },
  }),
  settleMs: z.natural().max(5000).default(400).volatile().i18n({
    'zh-CN': { $description: '操作后等待界面稳定的毫秒数，再截图' },
    'en-US': { $description: 'Milliseconds to wait after an action before the screenshot' },
  }),
  maxLongEdge: z.natural().min(640).max(3840).default(1366).volatile().i18n({
    'zh-CN': { $description: '截图最长边像素（越大越清晰、越费 token）' },
    'en-US': { $description: 'Screenshot long-edge limit in pixels' },
  }),
  maxPixels: z.natural().min(300_000).max(8_000_000).default(1_150_000).volatile().i18n({
    'zh-CN': { $description: '截图总像素上限' },
    'en-US': { $description: 'Screenshot total pixel limit' },
  }),
  jpegQuality: z.natural().min(30).max(100).default(80).volatile().i18n({
    'zh-CN': { $description: '截图 JPEG 质量' },
    'en-US': { $description: 'Screenshot JPEG quality' },
  }),
  blockedApps: z.array(z.string()).default([]).volatile().i18n({
    'zh-CN': { $description: '禁止操控的应用（名称或 exe，如 “alipay”）。常见密码管理器默认已禁止。' },
    'en-US': { $description: 'Apps that may never be controlled (names or exe). Common password managers are always blocked.' },
  }),
}) as unknown as z<Config>

/** Unwrap `.volatile()` refs (`{ get() }`) and fall back to defaults for bad values. */
export function resolveConfig(raw: unknown): Settings {
  const out: Record<string, unknown> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get: () => unknown }).get()
        : value
    }
  }
  const num = (key: 'settleMs' | 'maxLongEdge' | 'maxPixels' | 'jpegQuality', min: number, max: number): number => {
    const value = out[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULTS[key]
  }
  const bool = (key: 'overlay' | 'minimizeHostWindow' | 'autoScreenshot'): boolean => typeof out[key] === 'boolean' ? out[key] : DEFAULTS[key]
  return {
    accessMode: out.accessMode === 'allow-all' || out.accessMode === 'per-app' ? out.accessMode : DEFAULTS.accessMode,
    overlay: bool('overlay'),
    overlayLabel: typeof out.overlayLabel === 'string' && out.overlayLabel.trim() !== '' ? out.overlayLabel.trim().slice(0, 40) : DEFAULTS.overlayLabel,
    minimizeHostWindow: bool('minimizeHostWindow'),
    autoScreenshot: bool('autoScreenshot'),
    settleMs: num('settleMs', 0, 5000),
    maxLongEdge: num('maxLongEdge', 640, 3840),
    maxPixels: num('maxPixels', 300_000, 8_000_000),
    jpegQuality: num('jpegQuality', 30, 100),
    blockedApps: Array.isArray(out.blockedApps) ? out.blockedApps.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [],
  }
}

/** The slice of a host Agent this plugin touches. */
interface AgentLike extends CancellableAgent {
  readonly session: { readonly id: string; requestHeader?(): { config?: { provider?: string; model?: string } } | undefined }
  readonly options?: { provider?: string; model?: string }
}

interface ExecLike { agent?: AgentLike; signal: AbortSignal; name: string; arguments: unknown }

export function apply(ctx: Context, config: Config = {}): void {
  if (process.platform !== 'win32') {
    ctx.logger.warn('dsh-computer-use only supports Windows; no tools registered.')
    return
  }
  const settings = (): Settings => resolveConfig(config)
  const log = (message: string): void => ctx.logger.info(message)
  const helper = new HelperClient(message => ctx.logger.warn(message))
  const access = new AccessControl()
  const overlay = new OverlayController(helper, settings, log)
  const computer = new Computer(helper, access, overlay, settings)
  ctx.effect(() => () => {
    void overlay.end().finally(() => helper.dispose())
  }, 'computer-use: helper')

  // Vision support per provider/model route, resolved once.
  const visionCache = new Map<string, Promise<boolean>>()
  const supportsVision = (agent: AgentLike | undefined, signal: AbortSignal): Promise<boolean> => {
    const route = agent?.session.requestHeader?.()?.config ?? agent?.options
    const provider = route?.provider
    const model = route?.model
    const llm = (ctx as unknown as { get(name: string): unknown }).get('llm') as { resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }> } | undefined
    if (!provider || !model || typeof llm?.resolveModelInfo !== 'function') return Promise.resolve(true)
    const key = `${provider}\u0000${model}`
    let cached = visionCache.get(key)
    if (!cached) {
      cached = llm.resolveModelInfo(provider, model, signal)
        .then(info => info.inputModalities === undefined || info.inputModalities.includes('image'))
        .catch(() => { visionCache.delete(key); return true })
      visionCache.set(key, cached)
    }
    return cached
  }

  const attachments = (): AttachmentStore => ctx.attachments as AttachmentStore
  const tools = createTools({
    computer,
    saveImage: (shot, fileName) => attachments().saveImage({ data: shot.data, mediaType: 'image/jpeg', name: fileName }),
    async context(raw): Promise<CallContext> {
      const exec = raw as ExecLike
      return {
        session: exec.agent?.session.id ?? 'default',
        agent: exec.agent,
        signal: exec.signal,
        vision: await supportsVision(exec.agent, exec.signal),
      }
    },
  })
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `computer-use: tool ${tool.name}`)

  // request_access goes through DSH's own approval prompt.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'request_access' || settings().accessMode !== 'per-app') return next()
    const agent = exec.agent as AgentLike | undefined
    const apps = ((exec.arguments as { apps?: unknown } | undefined)?.apps ?? []) as unknown[]
    const names = apps.map(String).filter(app => app.trim() !== '' && !normalizeApp(app).includes('deepseek harness'))
    const session = agent?.session.id ?? 'default'
    const missing = access.missing(session, names)
    if (missing.length === 0) return next()
    const approval = (ctx as unknown as { get(name: string): unknown }).get('approval') as { effectivePolicy?(session: unknown): string } | undefined
    // "never" comes from the full-access / auto presets: the user opted out of
    // prompts, so grant without asking (the host window and blocked apps stay off-limits).
    if (agent && approval?.effectivePolicy?.(agent.session) === 'never') return next()
    const reason = String((exec.arguments as { reason?: unknown } | undefined)?.reason ?? '').slice(0, 200)
    return {
      kind: 'ask',
      reason: `Control these apps with mouse and keyboard: ${missing.join(', ')}`,
      displayReason: {
        en: `Let DeepSeek control ${missing.join(', ')} on this computer for this session?${reason ? ` (${reason})` : ''}`,
        'zh-CN': `允许 DeepSeek 在本次会话中操控：${missing.join('、')}？${reason ? `（${reason}）` : ''}`,
      },
    }
  })

  // Hide the overlay when the controlling agent stops running.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle' && overlay.controller === (agent as unknown)) void overlay.end(agent as unknown as CancellableAgent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    access.forget((agent as unknown as AgentLike).session.id)
    if (overlay.controller === (agent as unknown)) void overlay.end()
  })

  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    let registered: AccessMode | undefined
    let dispose: (() => void) | undefined
    const refresh = (): void => {
      const mode = settings().accessMode
      if (mode === registered) return
      dispose?.()
      registered = mode
      dispose = promptCtx.systemPrompt.section({ name: 'computer-use:guide', order: 72, text: promptText(mode) })
    }
    promptCtx.effect(() => {
      refresh()
      return () => { dispose?.(); dispose = undefined; registered = undefined }
    }, 'computer-use: prompt')
    promptCtx.on('loader/volatile-update' as never, (() => refresh()) as never)
  })

}
