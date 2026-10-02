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

export type HostWindowMode = 'card' | 'minimize' | 'keep'

export interface OverlaySettings {
  overlay: boolean
  overlayLabel: string
  hostWindow: HostWindowMode
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
  /** Paused by Esc or the pill; actions wait until resumed. */
  paused = false
  /** When the user last typed on the physical keyboard while the overlay was up (ms epoch). */
  lastUserInput = 0

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
      else if (event.event === 'user_input') this.lastUserInput = Date.now()
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
      await this.shrinkHost(settings.hostWindow)
      if (settings.overlay) {
        await this.helper.call('overlay_show', {
          label: `${settings.overlayLabel || 'DeepSeek Harness'} 正在操控你的电脑`,
          status,
          icon: this.iconPath,
          idleMs: settings.userIdleMs,
        }).catch(error => this.log(`overlay: ${String(error)}`))
      }
      return
    }
    await this.status(status)
  }

  async status(status: string): Promise<void> {
    if (this.visible && this.settings().overlay) await this.helper.call('overlay_status', { status }).catch(() => {})
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
      if (mode === 'minimize') {
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
      await this.helper.call('window_card', { hwnd: main.hwnd, ...cardRect(display) })
      this.hostWindows = [{ hwnd: main.hwnd, mode: 'card' }]
    } catch (error) {
      this.log(`host window ${mode}: ${String(error)}`)
    }
  }

  private async restoreHost(): Promise<void> {
    const windows = this.hostWindows
    this.hostWindows = []
    for (const win of windows) {
      if (win.mode === 'card') await this.helper.call('window_uncard', { hwnd: win.hwnd }).catch(() => {})
      else await this.helper.call('window_cmd', { hwnd: win.hwnd, op: 'restore' }).catch(() => {})
    }
  }
}
