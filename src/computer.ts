/**
 * The computer-use engine behind the tools: one coordinate space (the latest
 * screenshot of the current display), access checks against the window that
 * will receive the input, overlay status, and post-action screenshots.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { AccessControl, AccessMode, WindowLike } from './access.js'
import { contains, regionToPhysical, screenshotSize, toPhysical, toScreenshot, type Display, type Point, type Size } from './coords.js'
import type { HelperLike } from './helper-client.js'
import { parseKeys, parseModifiers } from './keys.js'
import type { CancellableAgent, HostWindowMode, OverlayController } from './overlay.js'

export interface Settings {
  accessMode: AccessMode
  blockedApps: string[]
  overlay: boolean
  overlayLabel: string
  hostWindow: HostWindowMode
  maxLongEdge: number
  maxPixels: number
  jpegQuality: number
  autoScreenshot: boolean
  settleMs: number
  /** Pause while the user types on the physical keyboard. */
  pauseOnUserInput: boolean
  /** How long the keyboard must be quiet before resuming. */
  userIdleMs: number
}

export interface WindowInfo extends WindowLike {
  hwnd: number
  pid: number
  className: string
  path: string
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
  maximized: boolean
  foreground?: boolean
}

export interface Shot {
  data: Uint8Array
  width: number
  height: number
}

/** What a tool call knows about its caller. */
export interface CallContext {
  session: string
  agent: CancellableAgent | undefined
  signal: AbortSignal
  /** Whether the conversation model can look at images. */
  vision: boolean
}

export const ACTIONS = [
  'screenshot', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'mouse_move', 'left_click_drag', 'left_mouse_down', 'left_mouse_up', 'scroll',
  'type', 'key', 'hold_key', 'wait', 'zoom', 'cursor_position',
] as const
export type Action = typeof ACTIONS[number]

export interface ActionInput {
  action: Action
  coordinate?: number[]
  start_coordinate?: number[]
  text?: string
  modifiers?: string
  scroll_direction?: 'up' | 'down' | 'left' | 'right'
  scroll_amount?: number
  duration?: number
  region?: number[]
}

/** Actions that change something on screen and deserve a fresh screenshot. */
const MUTATING = new Set<Action>([
  'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click', 'left_click_drag',
  'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'mouse_move',
])

export interface ActionOutcome {
  text: string
  /** A screenshot or zoom image to return to the model. */
  image?: Shot
  /** The action was not performed because the user took over the keyboard. */
  skipped?: boolean
}

/** Actions that wait for the user to stop typing before they run. */
const INPUT = new Set<Action>([...MUTATING].filter(action => action !== 'mouse_move'))

export class Computer {
  private displays: Display[] = []
  private displayIndex = -1
  private heldButton = false

  constructor(
    readonly helper: HelperLike,
    readonly access: AccessControl,
    readonly overlay: OverlayController,
    readonly settings: () => Settings,
  ) {}

  // ------------------------------------------------------------ displays

  async refreshDisplays(): Promise<Display[]> {
    const rows = await this.helper.call<Display[]>('displays')
    if (rows.length === 0) throw new Error('No display found.')
    this.displays = rows
    if (this.displayIndex < 0 || this.displayIndex >= rows.length) {
      this.displayIndex = Math.max(0, rows.findIndex(row => row.primary))
    }
    return rows
  }

  async display(): Promise<Display> {
    if (this.displays.length === 0) await this.refreshDisplays()
    return this.displays[this.displayIndex] ?? this.displays[0]!
  }

  async selectDisplay(index: number): Promise<Display> {
    const rows = await this.refreshDisplays()
    if (!Number.isInteger(index) || index < 0 || index >= rows.length) throw new Error(`Display ${index} does not exist; there are ${rows.length} (0-${rows.length - 1}).`)
    this.displayIndex = index
    return rows[index]!
  }

  get currentIndex(): number {
    return Math.max(0, this.displayIndex)
  }

  shotSize(display: Display): Size {
    const s = this.settings()
    return screenshotSize(display, { maxLongEdge: s.maxLongEdge, maxPixels: s.maxPixels })
  }

  private async point(coordinate: number[] | undefined, field = 'coordinate'): Promise<Point> {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) throw new Error(`${field} must be [x, y] in screenshot pixels.`)
    const display = await this.display()
    return toPhysical({ x: coordinate[0]!, y: coordinate[1]! }, display, this.shotSize(display))
  }

  async toModel(point: Point): Promise<Point & { offscreen: boolean }> {
    const display = await this.display()
    return { ...toScreenshot(point, display, this.shotSize(display)), offscreen: !contains(display, point) }
  }

  // ---------------------------------------------------------- screenshots

  async screenshot(): Promise<Shot> {
    await this.refreshDisplays()
    const display = await this.display()
    const size = this.shotSize(display)
    const shot = await this.capture(display, size)
    await this.remember()
    return shot
  }

  /** The foreground window as of the model's latest look at the screen. */
  private seen: WindowInfo | undefined

  private async remember(): Promise<void> {
    this.seen = await this.foreground().catch(() => undefined)
  }

  /**
   * Did another window come to the front since the model last looked, without
   * the agent acting in between? Then the user (or a popup) changed the screen.
   */
  private async foregroundChanged(): Promise<WindowInfo | undefined> {
    const seen = this.seen
    if (!seen) return undefined
    const now = await this.foreground().catch(() => undefined)
    return now && now.hwnd !== seen.hwnd ? now : undefined
  }

  private async capture(rect: { x: number; y: number; width: number; height: number }, out: Size): Promise<Shot> {
    const result = await this.helper.call<{ data: string; width: number; height: number }>('screenshot', {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      outWidth: out.width, outHeight: out.height, quality: this.settings().jpegQuality,
    }, 30_000)
    return { data: Buffer.from(result.data, 'base64'), width: result.width, height: result.height }
  }

  async zoom(region: number[] | undefined): Promise<Shot> {
    if (!Array.isArray(region)) throw new Error('zoom needs region: [x1, y1, x2, y2] in screenshot pixels.')
    const display = await this.display()
    const rect = regionToPhysical(region, display, this.shotSize(display))
    const s = this.settings()
    // Show the region at native resolution, shrunk only to the screenshot limits.
    const out = screenshotSize(rect, { maxLongEdge: s.maxLongEdge, maxPixels: s.maxPixels })
    return this.capture(rect, out)
  }

  // ---------------------------------------------------------------- state

  async foreground(): Promise<WindowInfo | undefined> {
    const win = await this.helper.call<Partial<WindowInfo>>('foreground')
    return typeof win.hwnd === 'number' ? win as WindowInfo : undefined
  }

  async windowAt(point: Point): Promise<WindowInfo | undefined> {
    const win = await this.helper.call<Partial<WindowInfo>>('window_at', { ...point })
    return typeof win.hwnd === 'number' ? win as WindowInfo : undefined
  }

  async windows(): Promise<WindowInfo[]> {
    return this.helper.call<WindowInfo[]>('windows')
  }

  async cursor(): Promise<Point> {
    return this.helper.call<Point>('cursor')
  }

  /** Short description of the frontmost window, for result text. */
  async describeForeground(): Promise<string> {
    const win = await this.foreground().catch(() => undefined)
    this.seen = win
    if (!win) return 'Foreground window: none (desktop).'
    return `Foreground window: ${win.exe} — "${win.title.slice(0, 80)}".`
  }

  private assertAllowed(call: CallContext, win: WindowInfo | undefined, verb: string): void {
    const s = this.settings()
    const reason = this.access.denial(call.session, win, s.accessMode, s.blockedApps, verb)
    if (reason) throw new Error(reason)
  }

  private async checkPointer(call: CallContext, point: Point | undefined, verb: string): Promise<void> {
    const target = point ?? await this.cursor()
    this.assertAllowed(call, await this.windowAt(target), verb)
  }

  private async checkKeyboard(call: CallContext, verb: string): Promise<void> {
    this.assertAllowed(call, await this.foreground(), verb)
  }

  // -------------------------------------------------------------- actions

  /** Overlay status line for an action (Chinese, shown to the user). */
  static statusOf(input: ActionInput): string {
    const at = input.coordinate ? ` (${input.coordinate.join(', ')})` : ''
    switch (input.action) {
      case 'screenshot': return '查看屏幕'
      case 'zoom': return '放大查看'
      case 'left_click': return `点击${at}`
      case 'double_click': return `双击${at}`
      case 'triple_click': return `三击${at}`
      case 'right_click': return `右键${at}`
      case 'middle_click': return `中键${at}`
      case 'mouse_move': return `移动鼠标${at}`
      case 'left_click_drag': return `拖动到${at}`
      case 'left_mouse_down': return '按下鼠标'
      case 'left_mouse_up': return '松开鼠标'
      case 'scroll': return `滚动 ${input.scroll_direction ?? 'down'}${at}`
      case 'type': return `输入 “${(input.text ?? '').slice(0, 16)}${(input.text ?? '').length > 16 ? '…' : ''}”`
      case 'key': return `按键 ${input.text ?? ''}`
      case 'hold_key': return `按住 ${input.text ?? ''}`
      case 'wait': return '等待'
      case 'cursor_position': return '读取光标位置'
    }
  }

  /** Run one action. Returns text plus an image for screenshot/zoom. */
  async run(input: ActionInput, call: CallContext): Promise<ActionOutcome> {
    if (call.signal.aborted) throw new Error('Cancelled.')
    await this.overlay.begin(call.agent, Computer.statusOf(input))
    const { action } = input
    const s = this.settings()
    const wasPaused = this.overlay.paused
    if (await this.overlay.yieldToUser(call.signal, s.pauseOnUserInput && INPUT.has(action)) && INPUT.has(action)) {
      // The screen may have changed under the model's feet: re-plan from a fresh look.
      await this.overlay.begin(call.agent, Computer.statusOf(input))
      const why = wasPaused ? 'the user paused computer use (Esc) and has now resumed' : 'the user was typing on the keyboard, so you were paused until they stopped'
      return {
        text: `Not done: ${why}. ${action} was NOT performed. Look at the new screenshot and re-plan before acting.`,
        ...(call.vision ? { image: await this.screenshot() } : {}),
        skipped: true,
      }
    }
    if (s.pauseOnUserInput && INPUT.has(action)) {
      const changed = await this.foregroundChanged()
      if (changed) {
        await this.overlay.status('检测到窗口切换，重新查看屏幕')
        const image = call.vision ? await this.screenshot() : undefined
        if (!image) this.seen = changed
        return {
          text: `Not done: since your last look the foreground window changed to ${changed.exe} ("${changed.title.slice(0, 60)}") without you acting, most likely the user opened it. ${action} was NOT performed. Look at the new screenshot and decide whether to continue there, switch back, or ask the user.`,
          ...(image ? { image } : {}),
          skipped: true,
        }
      }
    }
    // From here the agent itself may change the foreground; only a new look re-arms the check.
    if (INPUT.has(action)) this.seen = undefined
    switch (action) {
      case 'screenshot': {
        const shot = await this.screenshot()
        return { text: `Screenshot ${shot.width}x${shot.height} of display ${this.currentIndex}.`, image: shot }
      }
      case 'zoom': {
        const shot = await this.zoom(input.region)
        return { text: `Zoomed view of region [${(input.region ?? []).join(', ')}] at ${shot.width}x${shot.height}. Pixel positions in this image are NOT screen coordinates; keep using full-screenshot coordinates for actions.`, image: shot }
      }
      case 'cursor_position': {
        const p = await this.toModel(await this.cursor())
        return { text: `Cursor at (${p.x}, ${p.y})${p.offscreen ? ' — on another display' : ''}.` }
      }
      case 'wait': {
        const seconds = Math.min(30, Math.max(0, input.duration ?? 1))
        await sleep(seconds * 1000, undefined, { signal: call.signal })
        return { text: `Waited ${seconds}s.` }
      }
      case 'mouse_move': {
        const p = await this.point(input.coordinate)
        await this.helper.call('move', { ...p })
        return { text: `Moved the mouse to (${input.coordinate!.join(', ')}).` }
      }
      case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
        const p = input.coordinate ? await this.point(input.coordinate) : undefined
        await this.checkPointer(call, p, 'click')
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left'
        const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1
        // Anthropic's schema passes click modifiers in `text`.
        const modifiers = parseModifiers(input.modifiers ?? input.text)
        await this.helper.call('click', { ...(p ?? {}), button, count, modifiers })
        return { text: `${action.replace('_', ' ')}${input.coordinate ? ` at (${input.coordinate.join(', ')})` : ' at the cursor'}${modifiers.length ? ` holding ${input.modifiers ?? input.text}` : ''}.` }
      }
      case 'left_click_drag': {
        const from = await this.point(input.start_coordinate, 'start_coordinate')
        const to = await this.point(input.coordinate)
        await this.checkPointer(call, from, 'drag in')
        await this.helper.call('drag', { x1: from.x, y1: from.y, x2: to.x, y2: to.y, button: 'left' })
        return { text: `Dragged from (${input.start_coordinate!.join(', ')}) to (${input.coordinate!.join(', ')}).` }
      }
      case 'left_mouse_down': case 'left_mouse_up': {
        const p = input.coordinate ? await this.point(input.coordinate) : undefined
        if (action === 'left_mouse_down') await this.checkPointer(call, p, 'press the mouse in')
        await this.helper.call('button', { ...(p ?? {}), button: 'left', up: action === 'left_mouse_up' })
        this.heldButton = action === 'left_mouse_down'
        return { text: `Left button ${action === 'left_mouse_down' ? 'down' : 'up'}.` }
      }
      case 'scroll': {
        const p = input.coordinate ? await this.point(input.coordinate) : undefined
        await this.checkPointer(call, p, 'scroll')
        const amount = Math.max(1, Math.min(30, Math.round(input.scroll_amount ?? 3)))
        const direction = input.scroll_direction ?? 'down'
        const dy = direction === 'down' ? amount : direction === 'up' ? -amount : 0
        const dx = direction === 'right' ? amount : direction === 'left' ? -amount : 0
        await this.helper.call('scroll', { ...(p ?? {}), dx, dy, modifiers: parseModifiers(input.modifiers) })
        return { text: `Scrolled ${direction} ${amount}.` }
      }
      case 'type': {
        const text = input.text ?? ''
        if (text === '') throw new Error('type needs text.')
        await this.checkKeyboard(call, 'type into')
        // Long text goes through the clipboard: faster and immune to autocomplete races.
        if (text.length > 200) await this.helper.call('paste', { text, restore: true })
        else await this.helper.call('type', { text }, 60_000)
        return { text: `Typed ${text.length} characters.` }
      }
      case 'key': {
        const combos = parseKeys(input.text ?? '')
        await this.checkKeyboard(call, 'send keys to')
        await this.helper.call('keys', { combos })
        return { text: `Pressed ${input.text}.` }
      }
      case 'hold_key': {
        const combos = parseKeys(input.text ?? '')
        const seconds = Math.min(10, Math.max(0.05, input.duration ?? 0.5))
        await this.checkKeyboard(call, 'send keys to')
        await this.helper.call('keys', { combos, holdMs: Math.round(seconds * 1000) }, 20_000)
        return { text: `Held ${input.text} for ${seconds}s.` }
      }
    }
  }

  /** Release a mouse button left down by an aborted run. */
  async releaseHeld(): Promise<void> {
    if (!this.heldButton) return
    this.heldButton = false
    await this.helper.call('button', { button: 'left', up: true }).catch(() => {})
  }

  /** After a mutating action: settle, then capture (vision models only). */
  async after(inputs: readonly ActionInput[], call: CallContext): Promise<Shot | undefined> {
    const s = this.settings()
    if (!s.autoScreenshot || !call.vision) return undefined
    if (!inputs.some(input => MUTATING.has(input.action))) return undefined
    await sleep(s.settleMs, undefined, { signal: call.signal })
    return this.screenshot()
  }

  // ------------------------------------------------------------- windows

  /** Bring a window forward and verify it is the foreground window. */
  async focus(win: WindowInfo): Promise<WindowInfo & { focused: boolean }> {
    return this.helper.call<WindowInfo & { focused: boolean }>('focus', { hwnd: win.hwnd })
  }

  /** Window rectangle in screenshot coordinates, for listings. */
  async windowBox(win: WindowInfo): Promise<string> {
    const a = await this.toModel({ x: win.x, y: win.y })
    const b = await this.toModel({ x: win.x + win.width, y: win.y + win.height })
    return `(${a.x}, ${a.y})-(${b.x}, ${b.y})${a.offscreen && b.offscreen ? ' other display' : ''}`
  }
}
