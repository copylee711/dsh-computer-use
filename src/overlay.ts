/**
 * The "AI is controlling your computer" indicator and the user's controls:
 * an orange glow around every display plus a status pill, both excluded from
 * screenshots. Shown on the first action of a run, hidden when that agent
 * goes idle. A physical Esc pauses / resumes, the stop button cancels the
 * agent, and typing on the keyboard makes the agent wait. While controlling,
 * the DeepSeek Harness window can shrink into an always-on-top card.
 */
import { isHostWindow } from './access.js'
import type { HelperLike } from './helper-client.js'

export interface CancellableAgent {
  cancel(cause: { kind: 'user' }): void
}

export type HostWindowMode = 'pet' | 'card' | 'minimize' | 'keep'

/** The slice of a DSH assistant-stream frame the progress card reads. */
export interface StreamFrame {
  type: string
  chunk?: { type: string; text?: string; name?: string }
}

/** Markdown reduced to one plain line for the progress card. */
export function plainLine(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|`|~~)/g, '')
    .replace(/\s+/g, ' ')
}

/** Friendly names of common tools on the card's activity line. */
const TOOL_NAMES: Record<string, string> = {
  computer: '操作电脑', computer_batch: '批量操作', open_application: '打开应用', windows: '窗口', ui_elements: '读取界面元素',
  clipboard: '剪贴板', request_access: '请求授权', pwsh: '运行命令', bash: '运行命令', shell: '运行命令',
  read: '读取文件', write: '写入文件', edit: '编辑文件', web_search: '搜索网页', web_fetch: '读取网页', todo_write: '更新待办',
}

/** Card text kept per line: the card shows the tail of it. */
const KEEP = 400

export interface OverlaySettings {
  overlay: boolean
  overlayLabel: string
  hostWindow: HostWindowMode
  cardOpacity: number
  userIdleMs: number
}

interface WindowRow { hwnd: number; exe: string; title: string; minimized: boolean; foreground?: boolean; x: number; y: number; width: number; height: number }
interface DisplayRow { x: number; y: number; width: number; height: number; workX: number; workY: number; workWidth: number; workHeight: number; primary: boolean; dpi: number }

/** Without a status change from the host, hide after this long without actions. */
const IDLE_HIDE_MS = 90_000
/** A pause longer than this ends the tool call with a message for the model. */
const MAX_PAUSE_MS = 25 * 60_000

/** Card rectangle in the bottom-right corner of a display's work area. */
export function cardRect(display: DisplayRow): { x: number; y: number; width: number; height: number } {
  const scale = display.dpi / 96
  const margin = Math.round(16 * scale)
  const width = Math.round(Math.min(Math.max(display.workWidth * 0.28, 400 * scale), 560 * scale, display.workWidth - 2 * margin))
  const height = Math.round(Math.min(display.workHeight * 0.66, display.workHeight - 2 * margin))
  return {
    x: display.workX + display.workWidth - width - margin,
    y: display.workY + display.workHeight - height - margin,
    width,
    height,
  }
}

export class OverlayController {
  private agent: CancellableAgent | undefined
  private visible = false
  private idleTimer: NodeJS.Timeout | undefined
  private hostWindows: Array<{ hwnd: number; mode: 'card' | 'minimize' }> = []
  private stopping = false
  /** Progress card lines: the reply as it streams, and what the agent is doing. */
  private streamAgent: unknown
  private text = ''
  private activity = ''
  private reasoning = ''
  private freshAttempt = true
  private pushTimer: NodeJS.Timeout | undefined
  private pushedActivity = ''
  /** Called when control starts (before the first action), e.g. to remember the window layout. */
  onStart: (() => Promise<void>) | undefined
  /** Opacity the card was last given, to apply setting changes while it floats. */
  private cardOpacity = 100
  /** Paused by Esc or the pill; actions wait until resumed. */
  paused = false
  /** When the user last typed on the physical keyboard while the overlay was up (ms epoch). */
  lastUserInput = 0
  /** Which physical key that was (helper reason, e.g. "vk=0x41"), for the log. */
  private lastUserKey = ''

  constructor(
    private readonly helper: HelperLike,
    private readonly settings: () => OverlaySettings,
    private readonly log: (message: string) => void,
    /** Absolute path of the pill icon (PNG). */
    private readonly iconPath = '',
  ) {
    helper.onEvent(event => {
      if (event.event === 'stop') this.stop(event.reason ?? 'user')
      else if (event.event === 'pause') this.paused = true
      else if (event.event === 'resume') this.paused = false
      else if (event.event === 'user_input') { this.lastUserInput = Date.now(); this.lastUserKey = event.reason ?? '' }
    })
  }

  /** The agent currently driving the computer, if any. */
  get controller(): CancellableAgent | undefined {
    return this.agent
  }

  /** Did the user type after `since`? */
  userTypedSince(since: number): boolean {
    return this.lastUserInput > since
  }

  /**
   * Hold the next action while the user has paused (Esc) or is typing.
   * Returns whether it had to wait, so the caller can re-check the screen.
   */
  async yieldToUser(signal: AbortSignal, waitForTyping: boolean): Promise<boolean> {
    const idleMs = this.settings().userIdleMs
    const typing = (): boolean => waitForTyping && Date.now() - this.lastUserInput < idleMs
    if (!this.paused && !typing()) return false
    if (!this.paused) this.log(`computer use waits: the user is typing (${this.lastUserKey})`)
    const started = Date.now()
    while (this.paused || typing()) {
      if (signal.aborted) throw new Error('Cancelled.')
      if (Date.now() - started > MAX_PAUSE_MS) {
        throw new Error('Computer use has been paused by the user for a long time. Stop here and ask the user whether to continue.')
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return true
  }

  /** Called before every action: shows the overlay once and updates its status line. */
  async begin(agent: CancellableAgent | undefined, status: string): Promise<void> {
    if (agent) this.agent = agent
    this.armIdle()
    const settings = this.settings()
    if (!this.visible) {
      this.visible = true
      this.paused = false
      await this.onStart?.().catch(error => this.log(`overlay start: ${String(error)}`))
      await this.shrinkHost(settings.hostWindow)
      const pet = settings.hostWindow === 'pet'
      if (settings.overlay || pet) {
        if (this.streamAgent !== agent) { this.text = ''; this.activity = '' }
        this.pushedActivity = status
        await this.helper.call('overlay_show', {
          label: pet ? `${settings.overlayLabel || 'DeepSeek Harness'} 正在操控` : `${settings.overlayLabel || 'DeepSeek Harness'} 正在操控你的电脑`,
          status,
          icon: this.iconPath,
          iconLight: this.iconPath.replace(/deepseek-white\.png$/, 'deepseek-black.png'),
          idleMs: settings.userIdleMs,
          glow: settings.overlay,
          pet,
          petOpacity: settings.cardOpacity,
          text: this.text.slice(-KEEP),
        }).catch(error => this.log(`overlay: ${String(error)}`))
      }
      return
    }
    if (settings.hostWindow === 'pet' && !this.hostWindows.some(win => win.mode === 'card')) await this.cardIfShown()
    if (this.hostWindows.some(win => win.mode === 'card') && settings.cardOpacity !== this.cardOpacity) {
      this.cardOpacity = settings.cardOpacity
      await this.helper.call('card_opacity', { opacity: settings.cardOpacity }).catch(() => {})
    }
    await this.status(status)
  }

  async status(status: string): Promise<void> {
    const settings = this.settings()
    if (!this.visible || !(settings.overlay || settings.hostWindow === 'pet')) return
    this.activity = status
    this.pushedActivity = status
    await this.helper.call('overlay_status', { status }).catch(() => {})
  }

  /** Live model output (DSH agent/assistant-stream) for the progress card. */
  stream(agent: unknown, frame: StreamFrame): void {
    if (agent !== this.streamAgent) { this.streamAgent = agent; this.text = ''; this.activity = ''; this.reasoning = '' }
    if (frame.type === 'start') { this.freshAttempt = true; this.reasoning = ''; return }
    const chunk = frame.type === 'chunk' ? frame.chunk : undefined
    if (!chunk) return
    if (chunk.type === 'text-delta' && chunk.text) {
      if (this.freshAttempt) { this.text = ''; this.freshAttempt = false }
      this.text = plainLine(this.text + chunk.text).slice(-KEEP)
    } else if (chunk.type === 'reasoning-delta' && chunk.text) {
      this.reasoning = plainLine(this.reasoning + chunk.text).slice(-KEEP)
      this.activity = `思考：${this.reasoning.trim()}`
    } else if (chunk.type === 'tool-call-delta' && chunk.name) {
      this.activity = `调用 ${TOOL_NAMES[chunk.name] ?? chunk.name}`
    } else return
    this.schedulePush()
  }

  /** A tool of another plugin started (computer-use tools report their own status). */
  toolStarted(agent: unknown, name: string, detail: string): void {
    if (agent !== this.streamAgent) return
    this.activity = `${TOOL_NAMES[name] ?? name}${detail ? `：${plainLine(detail)}` : ''}`
    this.schedulePush()
  }

  private schedulePush(): void {
    if (!this.visible || this.settings().hostWindow !== 'pet' || this.agent !== this.streamAgent || this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = undefined
      if (!this.visible) return
      const changed = this.activity !== this.pushedActivity
      this.pushedActivity = this.activity
      void this.helper.call('pet_update', { text: this.text.slice(-KEEP), ...(changed ? { activity: this.activity.slice(-KEEP) } : {}) }).catch(() => {})
    }, 80)
    this.pushTimer.unref?.()
  }

  /** Agent finished (idle), was cancelled, or the plugin is stopping. */
  async end(agent?: CancellableAgent): Promise<void> {
    if (agent !== undefined && this.agent !== undefined && agent !== this.agent) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.agent = undefined
    this.paused = false
    if (!this.visible) return
    this.visible = false
    await this.helper.call('overlay_hide').catch(() => {})
    await this.restoreHost()
  }

  private stop(reason: string): void {
    if (this.stopping) return
    this.stopping = true
    const agent = this.agent
    this.log(`computer use stopped by the user (${reason})`)
    try { agent?.cancel({ kind: 'user' }) } catch (error) { this.log(`cancel failed: ${String(error)}`) }
    void this.end().finally(() => { this.stopping = false })
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { void this.end() }, IDLE_HIDE_MS)
    this.idleTimer.unref()
  }

  /** Card: shrink the DSH window to an always-on-top corner card; minimize: get it out of the way. */
  private async shrinkHost(mode: HostWindowMode): Promise<void> {
    if (mode === 'keep') return
    try {
      const rows = (await this.helper.call<WindowRow[]>('windows')).filter(row => isHostWindow(row) && !row.minimized)
      if (rows.length === 0) return
      if (mode === 'minimize' || mode === 'pet') {
        for (const row of rows) await this.helper.call('window_cmd', { hwnd: row.hwnd, op: 'minimize' })
        this.hostWindows = rows.map(row => ({ hwnd: row.hwnd, mode: 'minimize' as const }))
        return
      }
      // The window the user is looking at (foreground), else the largest one.
      const main = rows.find(row => row.foreground) ?? rows.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
      const displays = await this.helper.call<DisplayRow[]>('displays')
      const cx = main.x + main.width / 2
      const cy = main.y + main.height / 2
      const display = displays.find(d => cx >= d.x && cx < d.x + d.width && cy >= d.y && cy < d.y + d.height) ?? displays.find(d => d.primary) ?? displays[0]
      if (!display) return
      this.cardOpacity = this.settings().cardOpacity
      await this.helper.call('window_card', { hwnd: main.hwnd, opacity: this.cardOpacity, ...cardRect(display) })
      this.hostWindows = [{ hwnd: main.hwnd, mode: 'card' }]
    } catch (error) {
      this.log(`host window ${mode}: ${String(error)}`)
    }
  }

  /**
   * Pet mode minimizes DeepSeek Harness; if the user opens it again while the
   * agent works, it floats as the see-through card instead of covering the
   * screen (the agent neither sees nor clicks it).
   */
  private async cardIfShown(): Promise<void> {
    try {
      const shown = (await this.helper.call<WindowRow[]>('windows')).filter(row => isHostWindow(row) && !row.minimized)
      if (shown.length === 0) return
      const before = this.hostWindows
      await this.shrinkHost('card')
      // Restore the other minimized windows too when control ends.
      this.hostWindows = [...this.hostWindows, ...before.filter(win => !this.hostWindows.some(card => card.hwnd === win.hwnd))]
    } catch (error) {
      this.log(`host window card: ${String(error)}`)
    }
  }

  private async restoreHost(): Promise<void> {
    const windows = this.hostWindows
    this.hostWindows = []
    for (const win of windows) {
      if (win.mode === 'card') {
        await this.helper.call('window_uncard', { hwnd: win.hwnd }).catch(() => {})
        // DeepSeek Harness has been seen hiding itself to the tray right after
        // the card is restored: bring it back if that happens.
        setTimeout(() => {
          void this.helper.call<WindowRow[]>('windows')
            .then(rows => rows.some(row => row.hwnd === win.hwnd) ? undefined : this.helper.call('window_cmd', { hwnd: win.hwnd, op: 'restore' }))
            .catch(() => {})
        }, 1200).unref()
      }
      else await this.helper.call('window_cmd', { hwnd: win.hwnd, op: 'restore' }).catch(() => {})
    }
  }
}
