import { describe, expect, it } from 'vitest'
import { AccessControl } from '../src/access.js'
import { Computer, type Settings } from '../src/computer.js'
import type { HelperEvent, HelperLike } from '../src/helper-client.js'
import { OverlayController, cardRect } from '../src/overlay.js'
import { createTools } from '../src/tools.js'

const SETTINGS: Settings = {
  accessMode: 'per-app', blockedApps: [], overlay: true, overlayLabel: 'DeepSeek Harness', hostWindow: 'keep',
  maxLongEdge: 1366, maxPixels: 1_150_000, jpegQuality: 80, autoScreenshot: true, settleMs: 0, pauseOnUserInput: true, userIdleMs: 50,
}
const CHROME = { hwnd: 11, exe: 'chrome.exe', title: 'GitHub - Google Chrome', pid: 1, className: 'Chrome_WidgetWin_1', path: '', x: 0, y: 0, width: 2560, height: 1504, minimized: false, maximized: true }
const HOST = { ...CHROME, hwnd: 22, exe: 'DeepSeek Harness.exe', title: 'chat — DeepSeek Harness' }

class FakeHelper implements HelperLike {
  calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  foreground = CHROME
  failOn = ''
  private listeners = new Set<(event: HelperEvent) => void>()
  async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ cmd, args })
    if (cmd === this.failOn) throw new Error(`${cmd} broke`)
    const answers: Record<string, unknown> = {
      displays: [{ x: 0, y: 0, width: 2560, height: 1600, primary: true, dpi: 192, name: 'D1' }],
      screenshot: { data: Buffer.from('jpeg').toString('base64'), width: args.outWidth, height: args.outHeight },
      foreground: this.foreground,
      window_at: this.foreground,
      windows: [CHROME, HOST],
      cursor: { x: 10, y: 10 },
    }
    return (answers[cmd] ?? null) as T
  }
  onEvent(listener: (event: HelperEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: HelperEvent): void { for (const listener of this.listeners) listener(event) }
  dispose(): void {}
}

function setup(options: { vision?: boolean; mode?: Settings['accessMode'] } = {}) {
  const helper = new FakeHelper()
  const access = new AccessControl()
  const settings = { ...SETTINGS, accessMode: options.mode ?? 'per-app' }
  const overlay = new OverlayController(helper, () => settings, () => {})
  const computer = new Computer(helper, access, overlay, () => settings)
  const saved: number[] = []
  let cancelled = 0
  const agent = { cancel: () => { cancelled++ } }
  const tools = createTools({
    computer,
    saveImage: async shot => {
      saved.push(shot.width)
      return { attachmentId: `att-${saved.length}`, mediaType: 'image/jpeg', bytes: 4, width: shot.width, height: shot.height } as never
    },
    context: async () => ({ session: 's1', agent, signal: new AbortController().signal, vision: options.vision ?? true }),
  })
  const tool = (name: string) => tools.find(t => t.name === name)!
  const run = (name: string, args: unknown) => tool(name).execute(args, {} as never) as Promise<{ text: string; image?: { attachmentId: string } }>
  const render = (name: string, value: unknown) => tool(name).output.render({}, value as never)
  return { helper, access, run, render, saved, cancelled: () => cancelled }
}

describe('computer tool', () => {
  it('converts screenshot coordinates to physical pixels and returns a fresh screenshot', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    const value = await t.run('computer', { action: 'left_click', coordinate: [678, 424] })
    const click = t.helper.calls.find(c => c.cmd === 'click')!
    expect(click.args.x).toBeGreaterThan(1270)
    expect(click.args.x).toBeLessThan(1290)
    expect(value.image?.attachmentId).toBe('att-1')
    const blocks = t.render('computer', value) as Array<{ type: string }>
    expect(blocks.map(b => b.type)).toEqual(['text', 'image'])
  })

  it('shows the overlay on the first action', async () => {
    const t = setup()
    await t.run('computer', { action: 'screenshot' })
    expect(t.helper.calls.some(c => c.cmd === 'overlay_show' && String(c.args.label).startsWith('DeepSeek'))).toBe(true)
  })

  it('refuses to click an ungranted app', async () => {
    const t = setup()
    await expect(t.run('computer', { action: 'left_click', coordinate: [10, 10] })).rejects.toThrow(/request_access/)
    expect(t.helper.calls.some(c => c.cmd === 'click')).toBe(false)
  })

  it('refuses to type into the DSH window even in allow-all mode', async () => {
    const t = setup({ mode: 'allow-all' })
    t.helper.foreground = HOST
    await expect(t.run('computer', { action: 'type', text: 'hi' })).rejects.toThrow(/DeepSeek Harness window/)
  })

  it('skips images for text-only models', async () => {
    const t = setup({ vision: false, mode: 'allow-all' })
    const value = await t.run('computer', { action: 'key', text: 'ctrl+l' })
    expect(value.image).toBeUndefined()
    expect(t.saved).toEqual([])
    expect(value.text).toMatch(/Foreground window: chrome.exe/)
  })

  it('cancels the controlling agent when the user clicks stop', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'key', text: 'Return' })
    t.helper.emit({ event: 'stop', reason: 'button' })
    expect(t.cancelled()).toBe(1)
  })

  it('holds actions while paused (Esc) and re-checks the screen after resume', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'screenshot' })
    t.helper.emit({ event: 'pause', reason: 'user' })
    const pending = t.run('computer', { action: 'left_click', coordinate: [100, 100] })
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(t.helper.calls.some(c => c.cmd === 'click')).toBe(false)
    t.helper.emit({ event: 'resume', reason: 'user' })
    const value = await pending
    expect(value.text).toMatch(/paused computer use \(Esc\) and has now resumed/)
    expect(t.helper.calls.some(c => c.cmd === 'click')).toBe(false)
    expect(t.cancelled()).toBe(0)
  })
})

describe('computer_batch', () => {
  it('stops at the first failure and still returns one screenshot', async () => {
    const t = setup({ mode: 'allow-all' })
    t.helper.failOn = 'keys'
    const value = await t.run('computer_batch', {
      actions: [
        { action: 'left_click', coordinate: [100, 100] },
        { action: 'key', text: 'ctrl+a' },
        { action: 'type', text: 'never typed' },
      ],
    })
    expect(value.text).toMatch(/Stopped: #2 key failed/)
    expect(t.helper.calls.some(c => c.cmd === 'type')).toBe(false)
    expect(t.saved.length).toBe(1)
  })
})

describe('windows tool', () => {
  it('lists process names and flags the DSH chat window', async () => {
    const t = setup()
    const value = await t.run('windows', { action: 'list' })
    expect(value.text).toMatch(/chrome\.exe/)
    expect(value.text).toMatch(/your own DeepSeek Harness chat window/)
  })
})

describe('keyboard takeover', () => {
  it('does not act while the user is typing, then returns a fresh screenshot', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'screenshot' })
    t.helper.emit({ event: 'user_input', reason: 'keyboard' })
    const value = await t.run('computer', { action: 'type', text: 'hello' })
    expect(value.text).toMatch(/NOT performed/)
    expect(value.image).toBeDefined()
    expect(t.helper.calls.some(c => c.cmd === 'type')).toBe(false)
  })

  it('stops a batch when the user types during it', async () => {
    const t = setup({ mode: 'allow-all' })
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await original<T>(cmd, args)
      if (cmd === 'click') t.helper.emit({ event: 'user_input', reason: 'keyboard' })
      return result
    }
    const value = await t.run('computer_batch', {
      actions: [
        { action: 'left_click', coordinate: [100, 100] },
        { action: 'type', text: 'never typed' },
      ],
    })
    expect(value.text).toMatch(/user typed on the keyboard meanwhile/)
    expect(t.helper.calls.some(c => c.cmd === 'type')).toBe(false)
  })

  it('ignores mouse movement entirely (only keyboard events exist)', async () => {
    const t = setup({ mode: 'allow-all' })
    const value = await t.run('computer', { action: 'key', text: 'Return' })
    expect(value.text).toMatch(/Pressed Return/)
  })
})

describe('foreground takeover', () => {
  it('skips the next action when another window came to the front since the last look', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'screenshot' })
    t.helper.foreground = { ...CHROME, hwnd: 99, exe: 'Notepad.exe', title: '新建文本文档' }
    const value = await t.run('computer', { action: 'left_click', coordinate: [100, 100] })
    expect(value.text).toMatch(/foreground window changed to Notepad\.exe/)
    expect(t.helper.calls.some(c => c.cmd === 'click')).toBe(false)
    const again = await t.run('computer', { action: 'left_click', coordinate: [100, 100] })
    expect(again.text).toMatch(/left click/)
  })

  it('does not flag window changes the agent caused itself', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'screenshot' })
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      const result = await original<T>(cmd, args)
      if (cmd === 'click') t.helper.foreground = { ...CHROME, hwnd: 77 } // the click opened a window
      return result
    }
    await t.run('computer_batch', { actions: [{ action: 'left_click', coordinate: [10, 10] }] })
    const value = await t.run('computer_batch', { actions: [{ action: 'key', text: 'ctrl+t' }] })
    expect(value.text).toMatch(/All 1 actions done/)
  })
})

describe('floating card', () => {
  it('fits a bottom-right card inside the work area', () => {
    const r = cardRect({ x: 0, y: 0, width: 2560, height: 1600, workX: 0, workY: 0, workWidth: 2560, workHeight: 1504, primary: true, dpi: 192 })
    expect(r.x + r.width).toBeLessThanOrEqual(2560)
    expect(r.y + r.height).toBeLessThanOrEqual(1504)
    expect(r.width).toBeGreaterThanOrEqual(800)
    expect(r.width).toBeLessThanOrEqual(1120)
  })
})
