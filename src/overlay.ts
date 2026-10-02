/**
 * The "AI is controlling your computer" indicator: an orange glow around
 * every display plus a status pill with a stop button, both excluded from
 * screenshots. Shown on the first action of a run, hidden when that agent
 * goes idle; a physical Esc or the stop button cancels the agent.
 */
import { isHostWindow } from './access.js'
import type { HelperLike } from './helper-client.js'

export interface CancellableAgent {
  cancel(cause: { kind: 'user' }): void
}

export interface OverlaySettings {
  overlay: boolean
  overlayLabel: string
  minimizeHostWindow: boolean
}

interface WindowRow { hwnd: number; exe: string; title: string; minimized: boolean }

/** Without a status change from the host, hide after this long without actions. */
const IDLE_HIDE_MS = 90_000

export class OverlayController {
  private agent: CancellableAgent | undefined
  private visible = false
  private idleTimer: NodeJS.Timeout | undefined
  private minimizedHost: number[] = []
  private stopping = false

  constructor(
    private readonly helper: HelperLike,
    private readonly settings: () => OverlaySettings,
    private readonly log: (message: string) => void,
  ) {
    helper.onEvent(event => {
      if (event.event === 'stop') this.stop(event.reason ?? 'user')
    })
  }

  /** The agent currently driving the computer, if any. */
  get controller(): CancellableAgent | undefined {
    return this.agent
  }

  /** Called before every action: shows the overlay once and updates its status line. */
  async begin(agent: CancellableAgent | undefined, status: string): Promise<void> {
    if (agent) this.agent = agent
    this.armIdle()
    const settings = this.settings()
    if (!this.visible) {
      this.visible = true
      if (settings.minimizeHostWindow) await this.minimizeHost()
      if (settings.overlay) {
        await this.helper.call('overlay_show', { label: `${settings.overlayLabel || 'DeepSeek'} 正在使用你的电脑`, status }).catch(error => this.log(`overlay: ${String(error)}`))
      }
      return
    }
    if (settings.overlay) await this.helper.call('overlay_status', { status }).catch(() => {})
  }

  /** Agent finished (idle), was cancelled, or the plugin is stopping. */
  async end(agent?: CancellableAgent): Promise<void> {
    if (agent !== undefined && this.agent !== undefined && agent !== this.agent) return
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.agent = undefined
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

  private async minimizeHost(): Promise<void> {
    try {
      const rows = await this.helper.call<WindowRow[]>('windows')
      const host = rows.filter(row => isHostWindow(row) && !row.minimized)
      for (const row of host) await this.helper.call('window_cmd', { hwnd: row.hwnd, op: 'minimize' })
      this.minimizedHost = host.map(row => row.hwnd)
    } catch (error) {
      this.log(`minimize host window: ${String(error)}`)
    }
  }

  private async restoreHost(): Promise<void> {
    const handles = this.minimizedHost
    this.minimizedHost = []
    for (const hwnd of handles) {
      await this.helper.call('window_cmd', { hwnd, op: 'restore' }).catch(() => {})
    }
  }
}
