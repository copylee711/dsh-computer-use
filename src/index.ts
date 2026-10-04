/**
 * @copylee/dsh-computer-use host bundle: Claude-style computer use for the
 * Windows desktop — screenshots in, mouse and keyboard out, per-app grants
 * through DSH approvals, and an orange "DeepSeek is using your computer"
 * overlay that a physical Esc dismisses.
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from './system-prompt-service.js'
import { AccessControl, normalizeApp, type AccessMode } from './access.js'
import { Computer, type CallContext, type Settings, type TypingMode } from './computer.js'
import { HelperClient, helperAssetPath } from './helper-client.js'
import { OverlayController, type CancellableAgent, type HostWindowMode, type StreamFrame } from './overlay.js'
import { promptText } from './prompt.js'
import { SkillStore } from './skills.js'
import { resolveConfig } from './settings.js'
import { PREVIEW_ROUTE, SCREENSHOTS_CLEAN_ROUTE, SCREENSHOTS_ROUTE, STATUS_ROUTE, SKILLS_ROUTE, skillsRoute, previewRoute, screenshotsCleanRoute, screenshotsRoute, statusRoute } from './routes.js'
import { ScreenshotCache } from './screenshots.js'
import { createTools } from './tools.js'

export { DEFAULTS, ENTRY_ID, resolveConfig } from './settings.js'

export const name = '@copylee/dsh-computer-use'
export const inject = ['tools', 'attachments']

export interface Config {
  accessMode?: AccessMode
  overlay?: boolean
  overlayLabel?: string
  hostWindow?: HostWindowMode
  cardOpacity?: number
  /** @deprecated replaced by hostWindow: 'minimize' */
  minimizeHostWindow?: boolean
  autoScreenshot?: boolean
  settleMs?: number
  maxLongEdge?: number
  maxPixels?: number
  jpegQuality?: number
  blockedApps?: string[]
  pauseOnUserInput?: boolean
  userIdleMs?: number
  typingMode?: TypingMode
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
  overlayLabel: z.string().default('DeepSeek Harness').volatile().i18n({
    'zh-CN': { $description: '提示条名称：“<名称> 正在操控你的电脑”' },
    'en-US': { $description: 'Name in the pill: "<name> 正在操控你的电脑"' },
  }),
  hostWindow: z.union([
    z.const('pet').i18n({ 'zh-CN': { $description: '最小化，改用右下角迷你进度卡片（两行滚动显示回复和思考 / 工具调用）' }, 'en-US': { $description: 'Minimize it and show a mini progress card (reply + thinking / tool calls)' } }),
    z.const('card').i18n({ 'zh-CN': { $description: '缩成右下角置顶悬浮卡片' }, 'en-US': { $description: 'Shrink to an always-on-top card' } }),
    z.const('minimize').i18n({ 'zh-CN': { $description: '最小化' }, 'en-US': { $description: 'Minimize' } }),
    z.const('keep').i18n({ 'zh-CN': { $description: '保持不变' }, 'en-US': { $description: 'Leave it as is' } }),
  ]).default('pet').volatile().i18n({
    'zh-CN': { $description: '操控期间 DeepSeek Harness 窗口怎么摆放（结束后自动恢复原尺寸和位置）' },
    'en-US': { $description: 'What to do with the DeepSeek Harness window while controlling (restored afterwards)' },
  }),
  cardOpacity: z.natural().min(30).max(100).default(80).volatile().i18n({
    'zh-CN': { $description: '悬浮卡片不透明度（%）：调低可透过卡片看清下面的操作过程；鼠标停在卡片上时变为不透明' },
    'en-US': { $description: 'Card opacity (%): lower lets you watch the work underneath; it turns opaque while the pointer rests on it' },
  }),
  typingMode: z.union([
    z.const('stream').i18n({ 'zh-CN': { $description: '流式：长文本按段落逐段粘贴，看得到一段段出现（推荐）' }, 'en-US': { $description: 'Stream: paste long text paragraph by paragraph (recommended)' } }),
    z.const('type').i18n({ 'zh-CN': { $description: '逐字输入：像人打字，慢；Markdown 编辑器里可能被自动格式化打乱' }, 'en-US': { $description: 'Type key by key: like a person, slow; Markdown editors may auto-format it' } }),
    z.const('paste').i18n({ 'zh-CN': { $description: '一次粘贴：最快' }, 'en-US': { $description: 'Paste at once: fastest' } }),
  ]).default('stream').volatile().i18n({
    'zh-CN': { $description: '文字输入方式' },
    'en-US': { $description: 'How text is entered' },
  }),
  autoScreenshot: z.boolean().default(true).volatile().i18n({
    'zh-CN': { $description: '每次操作后自动回传截图（省去一轮调用）' },
    'en-US': { $description: 'Return a screenshot after every action (saves a round trip)' },
  }),
  settleMs: z.natural().max(5000).default(400).volatile().i18n({
    'zh-CN': { $description: '操作后至少等待的毫秒数；之后画面静止即截图（最多约 2.5 秒）' },
    'en-US': { $description: 'Minimum wait after an action; then the screenshot is taken once the screen stops changing (up to ~2.5 s)' },
  }),
  maxLongEdge: z.natural().min(640).max(3840).default(1366).volatile().i18n({
    'zh-CN': { $description: '截图最长边像素（越大越清晰、越费 token）' },
    'en-US': { $description: 'Screenshot long-edge limit in pixels' },
  }),
  maxPixels: z.natural().min(300_000).max(8_000_000).default(1_150_000).volatile().i18n({
    'zh-CN': { $description: '截图总像素上限' },
    'en-US': { $description: 'Screenshot total pixel limit' },
  }),
  jpegQuality: z.natural().min(30).max(100).default(70).volatile().i18n({
    'zh-CN': { $description: '截图 JPEG 质量' },
    'en-US': { $description: 'Screenshot JPEG quality' },
  }),
  pauseOnUserInput: z.boolean().default(true).volatile().i18n({
    'zh-CN': { $description: '检测到你在操作时让出控制：你用键盘打字时暂停、停手后继续；你切换或打开了新窗口时，AI 重新看屏幕再决定（鼠标移动不会触发）' },
    'en-US': { $description: 'Yield to you: pause while you type, and re-check the screen when you bring up another window (mouse movement is ignored)' },
  }),
  userIdleMs: z.natural().min(300).max(10_000).default(1500).volatile().i18n({
    'zh-CN': { $description: '键盘停止多少毫秒后恢复操作' },
    'en-US': { $description: 'Milliseconds of keyboard quiet before resuming' },
  }),
  blockedApps: z.array(z.string()).default([]).volatile().i18n({
    'zh-CN': { $description: '禁止操控的应用（名称或 exe，如 “alipay”）。常见密码管理器默认已禁止。' },
    'en-US': { $description: 'Apps that may never be controlled (names or exe). Common password managers are always blocked.' },
  }),
}) as unknown as z<Config>


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
  const iconPath = helperAssetPath('deepseek-white.png')
  const overlay = new OverlayController(helper, settings, log, iconPath)
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

  /** "never" comes from the full-access / auto presets: the user opted out of approval prompts. */
  const approvalPolicy = (agent: { session: unknown }): string | undefined => {
    const approval = (ctx as unknown as { get(name: string): unknown }).get('approval') as { effectivePolicy?(session: unknown): string } | undefined
    try { return approval?.effectivePolicy?.(agent.session) } catch { return undefined }
  }

  // Orphaned screenshots (their session was deleted) are removed shortly after
  // start-up and twice a day; referenced ones are never touched.
  const screenshots = new ScreenshotCache(undefined, undefined, log)
  ctx.effect(() => {
    const sweep = (): void => { void screenshots.clean().catch(error => log(`screenshot cleanup skipped: ${String(error)}`)) }
    const first = setTimeout(sweep, 2 * 60_000)
    const every = setInterval(sweep, 12 * 60 * 60_000)
    first.unref(); every.unref()
    return () => { clearTimeout(first); clearInterval(every) }
  }, 'computer-use: screenshot cleanup')
  const skills = new SkillStore(helperAssetPath('skills'))
  const tools = createTools({
    computer,
    skills,
    async saveImage(shot, fileName) {
      const ref = await attachments().saveImage({ data: shot.data, mediaType: 'image/jpeg', name: fileName })
      screenshots.record(String(ref.attachmentId))
      return ref
    },
    async context(raw): Promise<CallContext> {
      const exec = raw as ExecLike
      return {
        session: exec.agent?.session.id ?? 'default',
        agent: exec.agent,
        signal: exec.signal,
        vision: await supportsVision(exec.agent, exec.signal),
        autoApprove: exec.agent !== undefined && approvalPolicy(exec.agent) === 'never',
      }
    },
  })
  for (const tool of tools) ctx.effect(() => ctx.tools.register(tool), `computer-use: tool ${tool.name}`)
  const OWN_TOOLS = new Set(tools.map(tool => tool.name))

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

  // The progress card shows the reply and the thinking / tool calls as they stream.
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    overlay.stream(agent, frame as unknown as StreamFrame)
  })
  ctx.on('tools/pre-execute', (exec, next) => {
    if (!OWN_TOOLS.has(exec.name)) {
      const args = (exec.arguments ?? {}) as Record<string, unknown>
      const detail = [args.command, args.description, args.query, args.path, args.url].find(value => typeof value === 'string') as string | undefined
      overlay.toolStarted(exec.agent, exec.name, (detail ?? '').split('\n')[0]!.slice(0, 120))
    }
    return next()
  })

  // An instruction typed into the progress card steers the running agent, like typing in DeepSeek Harness.
  overlay.onMessage = (agent, text) => {
    const steer = (agent as unknown as { steer?: (message: unknown) => void }).steer
    if (typeof steer !== 'function') { log('progress card: this agent cannot take steering'); return }
    steer.call(agent, Object.freeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }))
  }

  // Hide the overlay when the controlling agent stops running.
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') computer.resetLook()
    if (status === 'idle' && computer.clipboardAgent === (agent as unknown)) {
      computer.clipboardAgent = undefined
      void helper.call('clipboard_restore').catch(() => {})
    }
    if (status === 'idle' && overlay.controller === (agent as unknown)) void overlay.end(agent as unknown as CancellableAgent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    access.forget((agent as unknown as AgentLike).session.id)
    if (overlay.controller === (agent as unknown)) void overlay.end()
  })

  // Settings page bridge (status + overlay preview); optional so headless hosts still load.
  ctx.inject(['webServer'], (webCtx: Context) => {
    const route = (path: string, handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>): void => {
      // Never let a throw reach the host server: it answers a bare, body-less 400.
      const safe = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
        try {
          await handler(req, res)
        } catch (error) {
          if (res.headersSent) { res.destroy(); return }
          res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        }
      }
      webCtx.effect(() => webCtx.webServer.register({ kind: 'exact', path, handler: safe }), `computer-use: ${path}`)
    }
    route(STATUS_ROUTE, statusRoute(helper, settings, overlay))
    route(PREVIEW_ROUTE, previewRoute(helper, settings, overlay, iconPath))
    route(SCREENSHOTS_ROUTE, screenshotsRoute(screenshots))
    route(SCREENSHOTS_CLEAN_ROUTE, screenshotsCleanRoute(screenshots))
    route(SKILLS_ROUTE, skillsRoute(skills))
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
