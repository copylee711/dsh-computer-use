/**
 * The computer-use engine behind the tools: one coordinate space (the latest
 * screenshot of the current display), access checks against the window that
 * will receive the input, overlay status, and post-action screenshots.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { appMatches, isHostWindow, isTransientShell, type AccessControl, type AccessMode, type WindowLike } from './access.js'
import { contains, regionToPhysical, screenshotSize, toPhysical, toScreenshot, type Display, type Point, type Size } from './coords.js'
import type { HelperLike } from './helper-client.js'
import { parseKeys, parseModifiers } from './keys.js'
import { matchTarget, type UiElement } from './target.js'
import { splitBlocks, typingPieces } from './text.js'
import type { CancellableAgent, HostWindowMode, OverlayController } from './overlay.js'

export interface Settings {
  accessMode: AccessMode
  blockedApps: string[]
  overlay: boolean
  overlayLabel: string
  hostWindow: HostWindowMode
  /** Card opacity in percent while controlling (it turns opaque when the pointer rests on it). */
  cardOpacity: number
  maxLongEdge: number
  maxPixels: number
  jpegQuality: number
  autoScreenshot: boolean
  settleMs: number
  /** Pause while the user types on the physical keyboard. */
  pauseOnUserInput: boolean
  /** How long the keyboard must be quiet before resuming. */
  userIdleMs: number
  /** How text is entered: stream = paste block by block, type = key by key, paste = at once. */
  typingMode: TypingMode
}

export type TypingMode = 'stream' | 'type' | 'paste'

/** Visible typing pace (ms per character). */
const CHAR_DELAY_MS = 12
/** Text longer than this is pasted (stream / paste modes). */
const PASTE_OVER = 200

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
  /** The session never prompts for approval (full access / auto review): access requests are granted as they come. */
  autoApprove?: boolean
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
  /** A control named by what it says, instead of a coordinate. */
  target?: string
  /** wait: what to wait for ("window:记事本", "target:保存"). */
  until?: string
  /** wait: wait for it to disappear instead. */
  gone?: boolean
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

/** Actions whose input goes to the foreground window. */
const KEYBOARD = new Set<Action>(['type', 'key', 'hold_key'])

/** Below this fraction of changed sample pixels, the screen counts as unchanged. */
const UNCHANGED_DIFF = 0.0005

/** Text returned instead of an identical screenshot. */
export const UNCHANGED_TEXT = 'The screen looks exactly as in your previous screenshot: the action had no visible effect.'

/** How long a named control may take to appear before the action gives up. */
const TARGET_WAIT_MS = 3000
/** Pause between looks while waiting for a control or a window. */
const POLL_MS = 200

/** Longest adaptive wait for the screen to settle after an action. */
export const MAX_SETTLE_MS = 2500

export class Computer {
  private displays: Display[] = []
  private displayIndex = -1
  private heldButton = false
  /** The agent that last wrote the clipboard; when it goes idle the user's clipboard comes back. */
  clipboardAgent: CancellableAgent | undefined

  constructor(
    readonly helper: HelperLike,
    readonly access: AccessControl,
    readonly overlay: OverlayController,
    readonly settings: () => Settings,
  ) {
    overlay.onStart = () => this.noteStart()
  }

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
    const shot = await this.capture(display, size, { mark: true })
    await this.remember()
    return shot as Shot
  }


  /**
   * A fresh screenshot, or 'unchanged' when the screen looks the same as in
   * the last one the model saw (saves an image and tells it the action had no
   * visible effect).
   */
  async freshShot(): Promise<Shot | 'unchanged'> {
    await this.refreshDisplays()
    const display = await this.display()
    // One capture: the helper compares it with the last one shown and only encodes it if it differs.
    const shot = await this.capture(display, this.shotSize(display), { compare: true, threshold: UNCHANGED_DIFF })
    await this.remember()
    return shot ?? 'unchanged'
  }

  /** The foreground window as of the model's latest look at the screen. */
  private seen: WindowInfo | undefined
  /** The latest foreground window that was not DeepSeek Harness itself. */
  private lastTarget: WindowInfo | undefined

  /** A new turn starts: the user may have rearranged things while chatting. */
  resetLook(): void {
    this.seen = undefined
  }

  private async remember(): Promise<void> {
    const now = await this.foreground().catch(() => undefined)
    // A transient window (IME, the card's instruction box) is not where the agent works.
    if (!now || !isTransientShell(now)) this.seen = now
  }

  /**
   * Did another window come to the front since the model last looked, without
   * the agent acting in between? Then the user (or a popup) changed the screen.
   */
  private async foregroundChanged(): Promise<WindowInfo | undefined> {
    const seen = this.seen
    if (!seen) return undefined
    const now = await this.foreground().catch(() => undefined)
    // The same program swapping windows (Word's start screen becoming the document) is the app, not the user.
    return now && now.hwnd !== seen.hwnd && now.pid !== seen.pid ? now : undefined
  }

  private async capture(rect: { x: number; y: number; width: number; height: number }, out: Size, options: { mark?: boolean; compare?: boolean; threshold?: number } = {}): Promise<Shot | undefined> {
    const result = await this.helper.call<{ data?: string; width: number; height: number; unchanged?: boolean }>('screenshot', {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      outWidth: out.width, outHeight: out.height, quality: this.settings().jpegQuality, ...options,
    }, 30_000)
    if (result.unchanged || result.data === undefined) return undefined
    return { data: Buffer.from(result.data, 'base64'), width: result.width, height: result.height }
  }

  async zoom(region: number[] | undefined): Promise<Shot> {
    if (!Array.isArray(region)) throw new Error('zoom needs region: [x1, y1, x2, y2] in screenshot pixels.')
    const display = await this.display()
    const rect = regionToPhysical(region, display, this.shotSize(display))
    const s = this.settings()
    // Show the region at native resolution, shrunk only to the screenshot limits.
    const out = screenshotSize(rect, { maxLongEdge: s.maxLongEdge, maxPixels: s.maxPixels })
    return (await this.capture(rect, out))!
  }

  // ---------------------------------------------------------------- state

  async foreground(): Promise<WindowInfo | undefined> {
    const win = await this.helper.call<Partial<WindowInfo> | null>('foreground')
    if (!win || typeof win.hwnd !== 'number') return undefined
    if (!isHostWindow(win as WindowInfo) && !isTransientShell(win as WindowInfo)) this.lastTarget = win as WindowInfo
    return win as WindowInfo
  }

  /**
   * The user clicked into the DeepSeek Harness card (to read or scroll the
   * chat): keys would go there. Put the window the agent was working in back
   * in front instead of refusing.
   */
  private async refocusFromHost(): Promise<void> {
    const target = this.lastTarget
    const fg = await this.foreground().catch(() => undefined)
    if (!fg || !(isHostWindow(fg) || isTransientShell(fg)) || !target || target.hwnd === fg.hwnd) return
    const result = await this.focus(target).catch(() => undefined)
    if (result?.focused) await sleep(80)
  }

  /** Wait at most `maxMs`, returning once the screen has been still for ~0.8 s. Returns the time waited. */
  async waitForQuiet(maxMs: number, signal: AbortSignal): Promise<number> {
    const started = Date.now()
    if (maxMs <= 600) {
      await sleep(maxMs, undefined, { signal })
      return maxMs
    }
    const display = await this.display()
    const result = await this.helper.call<{ ms: number } | null>('settle', {
      x: display.x, y: display.y, width: display.width, height: display.height,
      minMs: 300, maxMs, quietMs: 800,
    }, maxMs + 10_000).catch(() => null)
    if (result === null) await sleep(Math.max(0, maxMs - (Date.now() - started)), undefined, { signal })
    if (signal.aborted) throw new Error('Cancelled.')
    return Date.now() - started
  }

  /** Wait until the screen stops changing (bounded), instead of a fixed delay. */
  async settle(signal: AbortSignal): Promise<void> {
    const s = this.settings()
    const display = await this.display()
    const result = await this.helper.call<{ ms: number } | null>('settle', {
      x: display.x, y: display.y, width: display.width, height: display.height,
      minMs: s.settleMs, maxMs: Math.max(s.settleMs, MAX_SETTLE_MS),
    }, 15_000).catch(() => null)
    if (result === null) await sleep(s.settleMs, undefined, { signal })
    if (signal.aborted) throw new Error('Cancelled.')
  }

  async windowAt(point: Point): Promise<WindowInfo | undefined> {
    const win = await this.helper.call<Partial<WindowInfo>>('window_at', { ...point })
    return typeof win.hwnd === 'number' ? win as WindowInfo : undefined
  }

  async windows(): Promise<WindowInfo[]> {
    return this.helper.call<WindowInfo[]>('windows')
  }

  /** Windows when control started (hwnd -> minimized), and windows brought back from the tray since. */
  private before: Map<number, boolean> | undefined
  private readonly fromTray = new Set<number>()

  /** Remember the window layout at the start of a task, to tell what the agent opened or restored. */
  async noteStart(): Promise<void> {
    const rows = await this.windows().catch(() => [])
    this.before = new Map((Array.isArray(rows) ? rows : []).map(row => [row.hwnd, row.minimized]))
    this.fromTray.clear()
  }

  noteFromTray(hwnd: number): void {
    this.fromTray.add(hwnd)
  }

  /** How a window relates to the layout before the task: opened by the agent, or restored from minimized / tray. */
  origin(win: WindowInfo): 'opened' | 'minimized' | 'tray' | undefined {
    if (this.fromTray.has(win.hwnd)) return win.minimized ? undefined : 'tray'
    if (!this.before) return undefined
    const was = this.before.get(win.hwnd)
    if (was === undefined) return 'opened'
    return was && !win.minimized ? 'minimized' : undefined
  }

  /** Programs running without any visible window (closed to the system tray); `tray` = has a tray icon. */
  async backgroundApps(tray = true): Promise<Array<WindowInfo & { tray: boolean }>> {
    // Whether each one has a tray icon costs a second or more to find out; callers that only match by name skip it.
    const rows = await this.helper.call<Array<WindowInfo & { tray: boolean }>>('background', { tray }, 15_000).catch(() => [])
    return Array.isArray(rows) ? rows : []
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
    const at = input.target ? ` “${input.target.slice(0, 20)}”` : input.coordinate ? ` (${input.coordinate.join(', ')})` : ''
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
      case 'wait': return input.until ? `等待 ${input.until.slice(0, 24)}${input.gone ? ' 消失' : ''}` : '等待'
      case 'cursor_position': return '读取光标位置'
    }
  }

  // -------------------------------------------------------------- targets

  /**
   * Controls of the foreground window, in physical pixels. `where` picks the
   * window itself or its popups (open menus and flyouts are windows of their
   * own). They are read separately because scanning both costs a second or
   * more on a file dialog, and the control is nearly always in the window.
   */
  async elements(where: 'window' | 'popups' = 'window'): Promise<UiElement[]> {
    const result = await this.helper.call<{ elements?: UiElement[] }>('ui', {
      includeText: true, maxNodes: 400, ...(where === 'popups' ? { popupsOnly: true } : {}),
    }, 20_000)
    return Array.isArray(result.elements) ? result.elements : []
  }

  /** Look for a named control in the window, and only if it is not there in its popups. */
  private async find(target: string): Promise<ReturnType<typeof matchTarget>> {
    const inWindow = await this.elements('window').catch(() => [])
    const match = matchTarget(inWindow, target)
    if (match.kind !== 'missing') return match
    const inPopups = await this.elements('popups').catch(() => [])
    if (inPopups.length === 0) return match
    const second = matchTarget(inPopups, target)
    return second.kind === 'missing' ? matchTarget([...inWindow, ...inPopups], target) : second
  }

  /**
   * Where a named control is. It may still be appearing (the menu just
   * opened), so look again for a few seconds before giving up; an ambiguous
   * name fails at once, with the candidates, rather than clicking a guess.
   */
  async locate(target: string, signal: AbortSignal, waitMs = TARGET_WAIT_MS): Promise<{ point: Point; element: UiElement }> {
    const started = Date.now()
    for (;;) {
      if (signal.aborted) throw new Error('Cancelled.')
      const match = await this.find(target)
      if (match.kind === 'found') {
        const el = match.element
        return { point: { x: Math.round(el.x + el.width / 2), y: Math.round(el.y + el.height / 2) }, element: el }
      }
      if (match.kind === 'ambiguous') {
        const list = await Promise.all(match.candidates.map(async el => {
          const at = await this.toModel({ x: el.x + el.width / 2, y: el.y + el.height / 2 })
          return `${el.role} "${el.name}" @ (${at.x}, ${at.y})`
        }))
        throw new Error(`target "${target}" matches ${match.candidates.length} controls: ${list.join('; ')}. Use one of these coordinates, or a more specific name.`)
      }
      if (Date.now() - started >= waitMs) {
        const near = match.suggestions.length
          ? ` Controls there now: ${match.suggestions.map(name => `"${name.slice(0, 40)}"`).join(', ')}.`
          : ' The window exposes no named controls; use coordinates from a screenshot.'
        throw new Error(`No control named "${target}" in the foreground window.${near}`)
      }
      await sleep(POLL_MS, undefined, { signal })
    }
  }

  /** The point an action aims at: a named control, a coordinate, or nothing (the cursor). */
  private async aim(input: ActionInput, call: CallContext): Promise<{ point: Point | undefined; label: string }> {
    if (typeof input.target === 'string' && input.target.trim() !== '') {
      const { point, element } = await this.locate(input.target, call.signal)
      return { point, label: ` on ${element.role} "${element.name.slice(0, 60)}"` }
    }
    if (input.coordinate) return { point: await this.point(input.coordinate), label: ` at (${input.coordinate.join(', ')})` }
    return { point: undefined, label: ' at the cursor' }
  }

  /** wait with `until`: done as soon as the window or control is there (or gone). */
  private async waitUntil(input: ActionInput, signal: AbortSignal): Promise<string> {
    const until = (input.until ?? '').trim()
    const split = until.search(/[:：]/)
    const prefix = split > 0 ? until.slice(0, split).trim().toLowerCase() : ''
    const kind = prefix === 'window' ? 'window' : 'target'
    const subject = (prefix === 'window' || prefix === 'target' ? until.slice(split + 1) : until).trim()
    if (subject === '') throw new Error('wait until needs "window:<title or exe>" or "target:<control name>".')
    const gone = input.gone === true
    const timeout = Math.min(60, Math.max(0.2, Number(input.duration ?? 10) || 10)) * 1000
    const needle = subject.toLowerCase()
    let suggestions: string[] = []
    let firstSeen: number | undefined
    const present = async (): Promise<boolean> => {
      if (kind === 'window') {
        // By title or exe, or by the app's name the way open_application understands it ("记事本" is Notepad.exe).
        const matches = (win: WindowInfo): boolean => win.title.toLowerCase().includes(needle) || win.exe.toLowerCase().includes(needle) || appMatches(subject, win)
        // Dialogs are owned windows and missing from the window list, but they take the foreground.
        const fg = await this.foreground().catch(() => undefined)
        if (fg && matches(fg)) return true
        const rows = await this.windows().catch(() => [])
        const found = (Array.isArray(rows) ? rows : []).filter(win => !win.minimized && matches(win))
        if (gone || found.length === 0) return found.length > 0
        // A window that exists but does not have the keyboard yet would lose the next keys:
        // give it a moment to come to the front before calling it there.
        if (found.some(win => win.foreground === true)) return true
        if (fg && found.some(win => win.hwnd === fg.hwnd || win.pid === fg.pid)) return true
        firstSeen ??= Date.now()
        return Date.now() - firstSeen > 1500
      }
      const match = await this.find(subject)
      if (match.kind === 'missing') suggestions = match.suggestions
      return match.kind !== 'missing'
    }
    const started = Date.now()
    for (;;) {
      if (signal.aborted) throw new Error('Cancelled.')
      if (await present() !== gone) {
        const text = `${kind === 'window' ? 'Window' : 'Control'} "${subject}" ${gone ? 'is gone' : 'is there'} after ${((Date.now() - started) / 1000).toFixed(1)}s.`
        // A window that just appeared is still drawing: the screenshot that follows should show it finished.
        await this.settle(signal)
        return text
      }
      if (Date.now() - started >= timeout) {
        const near = !gone && kind === 'target' && suggestions.length ? ` Controls there now: ${suggestions.map(name => `"${name.slice(0, 40)}"`).join(', ')}.` : ''
        throw new Error(`Timed out after ${Math.round(timeout / 1000)}s waiting for ${kind === 'window' ? 'window' : 'control'} "${subject}" to ${gone ? 'disappear' : 'appear'}.${near}`)
      }
      await sleep(POLL_MS, undefined, { signal })
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
      // Clicking into the DeepSeek Harness card is the user reading the chat, not a new task.
      if (changed && !isHostWindow(changed) && !isTransientShell(changed)) {
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
    if (KEYBOARD.has(action)) await this.refocusFromHost()
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
        // Up to `duration`, but done as soon as the screen has been still for a
        // moment: models ask for "wait 3s" after pages that already loaded.
        if (input.until) return { text: await this.waitUntil(input, call.signal) }
        const seconds = Math.min(30, Math.max(0, Number(input.duration ?? 1) || 0))
        const waited = await this.waitForQuiet(seconds * 1000, call.signal)
        return { text: waited < seconds * 1000 - 200 ? `Waited ${(waited / 1000).toFixed(1)}s (the screen settled early).` : `Waited ${seconds}s.` }
      }
      case 'mouse_move': {
        const { point: p, label } = await this.aim(input, call)
        if (!p) throw new Error('mouse_move needs coordinate or target.')
        await this.helper.call('move', { ...p })
        return { text: `Moved the mouse${label.replace(/^ (at|on)/, ' to')}.` }
      }
      case 'left_click': case 'right_click': case 'middle_click': case 'double_click': case 'triple_click': {
        const { point: p, label } = await this.aim(input, call)
        await this.checkPointer(call, p, 'click')
        const button = action === 'right_click' ? 'right' : action === 'middle_click' ? 'middle' : 'left'
        const count = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1
        // Anthropic's schema passes click modifiers in `text`.
        const modifiers = parseModifiers(input.modifiers ?? input.text)
        await this.helper.call('click', { ...(p ?? {}), button, count, modifiers })
        return { text: `${action.replace('_', ' ')}${label}${modifiers.length ? ` holding ${input.modifiers ?? input.text}` : ''}.` }
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
        const { point: p } = await this.aim(input, call)
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
        let into = ''
        if (input.target || input.coordinate) {
          // Click the field first: that is what gives it the keyboard.
          const { point: p, label } = await this.aim(input, call)
          await this.checkPointer(call, p, 'click')
          await this.helper.call('click', { ...(p ?? {}), button: 'left', count: 1, modifiers: [] })
          await sleep(120, undefined, { signal: call.signal })
          into = ` (clicked${label} first)`
        }
        await this.checkKeyboard(call, 'type into')
        return { text: `${await this.enterText(text, call)}${into}` }
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

  /**
   * Enter text the way the settings ask. Long text is pasted (literally: typing
   * Markdown key by key trips editors' auto-formatting); in stream mode block
   * by block so the user watches it appear. Between pieces the user can pause
   * (Esc / typing); if another window comes to the front meanwhile, stop.
   */
  private async enterText(text: string, call: CallContext): Promise<string> {
    const mode = this.settings().typingMode
    if (mode === 'paste' && text.length > PASTE_OVER) {
      await this.helper.call('paste', { text, restore: true })
      return `Typed ${text.length} characters (pasted).`
    }
    if (mode === 'stream' && text.length > PASTE_OVER) {
      const blocks = splitBlocks(text)
      await this.helper.call('clipboard_hold')
      try {
        await this.pieces(blocks, call, async (block, i) => {
          await this.overlay.status(`输入中 ${i + 1}/${blocks.length}`)
          await this.helper.call('paste', { text: block, restore: false, waitMs: 220 })
        })
      } finally {
        await this.helper.call('clipboard_release').catch(() => {})
      }
      return `Typed ${text.length} characters (streamed in ${blocks.length} blocks).`
    }
    const delay = mode === 'paste' ? 0 : CHAR_DELAY_MS
    await this.pieces(typingPieces(text), call, part => this.helper.call('type', { text: part, charDelay: delay }, 120_000).then(() => {}))
    return `Typed ${text.length} characters.`
  }

  /** Run `step` per piece; between pieces yield to the user and make sure the target window is still in front. */
  private async pieces(items: readonly string[], call: CallContext, step: (item: string, index: number) => Promise<void>): Promise<void> {
    const target = await this.foreground().catch(() => undefined)
    let done = 0
    for (const [index, item] of items.entries()) {
      if (call.signal.aborted) throw new Error('Cancelled.')
      if (index > 0 && await this.overlay.yieldToUser(call.signal, this.settings().pauseOnUserInput)) {
        const now = await this.foreground().catch(() => undefined)
        if (target && now && now.hwnd !== target.hwnd) {
          throw new Error(`Stopped after ${done} of ${items.join('').length} characters: the user paused and ${now.exe} is now in front. Check the screen and continue from where the text stops.`)
        }
      }
      await step(item, index)
      done += item.length
    }
  }

  /** Release a mouse button left down by an aborted run. */
  async releaseHeld(): Promise<void> {
    if (!this.heldButton) return
    this.heldButton = false
    await this.helper.call('button', { button: 'left', up: true }).catch(() => {})
  }

  /**
   * After a mutating action: wait for the screen to settle, then capture
   * (vision models only). A wait already waited, so it is captured at once:
   * "wait, then look" should be one step, not two.
   */
  async after(inputs: readonly ActionInput[], call: CallContext): Promise<Shot | 'unchanged' | undefined> {
    const s = this.settings()
    if (!s.autoScreenshot || !call.vision) return undefined
    const mutating = inputs.some(input => MUTATING.has(input.action))
    if (!mutating && !inputs.some(input => input.action === 'wait')) return undefined
    if (mutating) await this.settle(call.signal)
    return this.freshShot()
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
