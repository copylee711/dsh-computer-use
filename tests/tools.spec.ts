import { describe, expect, it } from 'vitest'
import { AccessControl } from '../src/access.js'
import { Computer, type Settings } from '../src/computer.js'
import type { HelperEvent, HelperLike } from '../src/helper-client.js'
import { OverlayController, cardRect } from '../src/overlay.js'
import { createTools } from '../src/tools.js'
import { SkillStore } from '../src/skills.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SETTINGS: Settings = {
  accessMode: 'per-app', blockedApps: [], overlay: true, overlayLabel: 'DeepSeek Harness', hostWindow: 'keep', cardOpacity: 80,
  maxLongEdge: 1366, maxPixels: 1_150_000, jpegQuality: 80, autoScreenshot: true, settleMs: 0, pauseOnUserInput: true, userIdleMs: 50, typingMode: 'paste',
}
const CHROME = { hwnd: 11, exe: 'chrome.exe', title: 'GitHub - Google Chrome', pid: 1, className: 'Chrome_WidgetWin_1', path: '', x: 0, y: 0, width: 2560, height: 1504, minimized: false, maximized: true }
const HOST = { ...CHROME, hwnd: 22, exe: 'DeepSeek Harness.exe', title: 'chat — DeepSeek Harness' }

class FakeHelper implements HelperLike {
  calls: Array<{ cmd: string; args: Record<string, unknown> }> = []
  foreground = CHROME
  failOn = ''
  /** UI Automation elements the window reports; a function lets a test change them between looks. */
  elements: unknown[] | (() => unknown[]) = []
  windowText = { text: '', length: 0, truncated: false, source: 'none' }
  private listeners = new Set<(event: HelperEvent) => void>()
  async call<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ cmd, args })
    if (cmd === this.failOn) throw new Error(`${cmd} broke`)
    if (cmd === 'ui') return { ...this.foreground, elements: typeof this.elements === 'function' ? this.elements() : this.elements } as T
    const answers: Record<string, unknown> = {
      displays: [{ x: 0, y: 0, width: 2560, height: 1600, primary: true, dpi: 192, name: 'D1' }],
      screenshot: { data: Buffer.from('jpeg').toString('base64'), width: args.outWidth, height: args.outHeight },
      foreground: this.foreground,
      window_at: this.foreground,
      windows: [CHROME, HOST],
      cursor: { x: 10, y: 10 },
      text: { ...this.foreground, ...this.windowText },
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

function setup(options: { vision?: boolean; mode?: Settings['accessMode']; typing?: Settings['typingMode']; skills?: SkillStore; autoApprove?: boolean } = {}) {
  const helper = new FakeHelper()
  const access = new AccessControl()
  const settings = { ...SETTINGS, accessMode: options.mode ?? 'per-app', typingMode: options.typing ?? SETTINGS.typingMode }
  const overlay = new OverlayController(helper, () => settings, () => {})
  const computer = new Computer(helper, access, overlay, () => settings)
  const saved: number[] = []
  let cancelled = 0
  const agent = { cancel: () => { cancelled++ } }
  const tools = createTools({
    computer,
    ...(options.skills ? { skills: options.skills } : {}),
    saveImage: async shot => {
      saved.push(shot.width)
      return { attachmentId: `att-${saved.length}`, mediaType: 'image/jpeg', bytes: 4, width: shot.width, height: shot.height } as never
    },
    context: async () => ({ session: 's1', agent, signal: new AbortController().signal, vision: options.vision ?? true, autoApprove: options.autoApprove ?? false }),
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
    t.helper.foreground = { ...CHROME, hwnd: 99, pid: 2, exe: 'Notepad.exe', title: '新建文本文档' }
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

describe('fewer round trips', () => {
  it('streams long text block by block and gives the clipboard back', async () => {
    const t = setup({ mode: 'allow-all', typing: 'stream' })
    const paragraph = '这是一段比较长的正文，用来测试流式输入是否按段落粘贴。'.repeat(3)
    const text = `${paragraph}

${paragraph}

${paragraph}
`
    const value = await t.run('computer', { action: 'type', text })
    expect(value.text).toMatch(/streamed in 3 blocks/)
    const cmds = t.helper.calls.map(c => c.cmd).filter(c => ['clipboard_hold', 'paste', 'clipboard_release'].includes(c))
    expect(cmds).toEqual(['clipboard_hold', 'paste', 'paste', 'paste', 'clipboard_release'])
    expect(t.helper.calls.filter(c => c.cmd === 'paste').map(c => c.args.text).join('')).toBe(text)
  })

  it('types short text visibly, one character at a time', async () => {
    const t = setup({ mode: 'allow-all', typing: 'stream' })
    await t.run('computer', { action: 'type', text: 'github.com' })
    const call = t.helper.calls.find(c => c.cmd === 'type')!
    expect(call.args.charDelay).toBeGreaterThan(0)
  })

  it('finds windows by program before matching the DSH chat title', async () => {
    const t = setup({ mode: 'allow-all' })
    t.helper.foreground = CHROME
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => cmd === 'windows'
      ? [{ ...HOST, title: '用 Chrome 打开 github — DeepSeek Harness' }, CHROME] as T
      : original<T>(cmd, args)
    const value = await t.run('windows', { action: 'maximize', name: 'chrome' })
    expect(value.text).toMatch(/maximize chrome\.exe/)
  })

  it('may minimize a window it is not allowed to control', async () => {
    const t = setup()
    const value = await t.run('windows', { action: 'minimize', hwnd: 11 })
    expect(value.text).toMatch(/minimize chrome\.exe/)
    expect(t.helper.calls.some(c => c.cmd === 'window_cmd' && c.args.op === 'minimize')).toBe(true)
  })

  it('returns a screenshot after wait', async () => {
    const t = setup()
    const value = await t.run('computer', { action: 'wait', duration: 0 })
    expect(value.image).toBeDefined()
    expect(t.helper.calls.some(c => c.cmd === 'settle')).toBe(false)
  })

  it('waits for the screen to settle before the post-action screenshot', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'key', text: 'Return' })
    const cmds = t.helper.calls.map(c => c.cmd)
    expect(cmds.lastIndexOf('settle')).toBeGreaterThan(cmds.indexOf('keys'))
    expect(cmds.lastIndexOf('screenshot')).toBeGreaterThan(cmds.lastIndexOf('settle'))
  })

  it('sends text instead of an identical screenshot when nothing changed', async () => {
    const t = setup({ mode: 'allow-all' })
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => cmd === 'screenshot' && args.compare ? { unchanged: true } as T : original<T>(cmd, args)
    const value = await t.run('computer', { action: 'key', text: 'F5' })
    expect(value.image).toBeUndefined()
    expect(value.text).toMatch(/no visible effect/)
  })

  it('puts the working window back when the user clicked into the DSH card', async () => {
    const t = setup({ mode: 'allow-all' })
    await t.run('computer', { action: 'screenshot' }) // Chrome in front
    t.helper.foreground = HOST
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (cmd === 'focus') { t.helper.foreground = CHROME; return { ...CHROME, focused: true } as T }
      return original<T>(cmd, args)
    }
    const value = await t.run('computer', { action: 'key', text: 'ctrl+t' })
    expect(value.text).toMatch(/Pressed ctrl\+t/)
    expect(t.helper.calls.find(c => c.cmd === 'keys')).toBeDefined()
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

describe('open_application with tray apps', () => {
  const QQ = { ...CHROME, hwnd: 33, exe: 'QQ.exe', title: 'QQ', tray: true }
  const withTray = (t: ReturnType<typeof setup>, restored: unknown) => {
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (cmd === 'background') { t.helper.calls.push({ cmd, args }); return [QQ] as T }
      if (cmd === 'tray_restore') { t.helper.calls.push({ cmd, args }); return restored as T }
      return original<T>(cmd, args)
    }
  }

  it('restores an app from its tray icon instead of launching a second copy', async () => {
    const t = setup({ mode: 'allow-all' })
    withTray(t, { icon: true, window: { ...QQ, focused: true } })
    const result = await t.run('open_application', { name: 'QQ' })
    expect(t.helper.calls.find(c => c.cmd === 'tray_restore')?.args.exe).toBe('QQ.exe')
    expect(t.helper.calls.some(c => c.cmd === 'launch')).toBe(false)
    expect(result.text).toContain('restored its window from the tray icon')
  })

  it('does not relaunch when the tray icon cannot bring the window back', async () => {
    const t = setup({ mode: 'allow-all' })
    withTray(t, { icon: false })
    const result = await t.run('open_application', { name: 'qq' })
    expect(t.helper.calls.some(c => c.cmd === 'launch')).toBe(false)
    expect(result.text).toContain('Do not launch it again')
  })

  it('lists tray apps in windows list', async () => {
    const t = setup({ mode: 'allow-all' })
    withTray(t, {})
    const result = await t.run('windows', { action: 'list' })
    expect(result.text).toContain('system tray without a window')
    expect(result.text).toContain('QQ.exe')
  })
})

describe('tidying up after a task', () => {
  it('marks opened / restored windows and tidy minimizes the restored ones', async () => {
    const t = setup({ mode: 'allow-all' })
    const NOTE = { ...CHROME, hwnd: 44, exe: 'notepad.exe', title: 'notes', minimized: true }
    let rows: unknown[] = [CHROME, HOST, NOTE]
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (cmd === 'windows') { t.helper.calls.push({ cmd, args }); return rows as T }
      return original<T>(cmd, args)
    }
    await t.run('computer', { action: 'key', text: 'ctrl+l' }) // control starts: layout remembered
    const PPT = { ...CHROME, hwnd: 55, exe: 'POWERPNT.EXE', title: 'slides' }
    rows = [CHROME, HOST, { ...NOTE, minimized: false }, PPT]
    const list = await t.run('windows', { action: 'list' })
    expect(list.text).toMatch(/notepad\.exe.*was minimized before this task/)
    expect(list.text).toMatch(/POWERPNT\.EXE.*opened during this task/)
    expect(list.text).not.toMatch(/chrome\.exe.*during this task/)
    const result = await t.run('windows', { action: 'tidy' })
    expect(t.helper.calls.find(c => c.cmd === 'window_cmd')?.args).toEqual({ hwnd: 44, op: 'minimize' })
    expect(result.text).toContain('POWERPNT.EXE')
  })

  it('new_instance launches even when the app is running', async () => {
    const t = setup({ mode: 'allow-all' })
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
      if (cmd === 'apps') { t.helper.calls.push({ cmd, args }); return [{ name: 'Google Chrome', id: 'Chrome' }] as T }
      if (cmd === 'launch') t.helper.foreground = { ...CHROME, hwnd: 99 }
      return original<T>(cmd, args)
    }
    await t.run('open_application', { name: 'chrome', new_instance: true })
    expect(t.helper.calls.some(c => c.cmd === 'launch')).toBe(true)
    expect(t.helper.calls.some(c => c.cmd === 'focus')).toBe(false)
  })
})

describe('progress card', () => {
  it('plainLine flattens Markdown into one line', async () => {
    const { plainLine } = await import('../src/overlay.js')
    expect(plainLine('## 标题\n\n- **加粗** 和 `代码`\n[链接](http://x)\n```js\nconst a = 1\n```\n完')).toBe('标题 加粗 和 代码 链接 完')
  })

  it('streams reply text and activity to the helper while controlling', async () => {
    const helper = new FakeHelper()
    const settings = { ...SETTINGS, hostWindow: 'pet' as const }
    const overlay = new OverlayController(helper, () => settings, () => {})
    const agent = { cancel: () => {} }
    overlay.stream(agent, { type: 'start' })
    overlay.stream(agent, { type: 'chunk', chunk: { type: 'text-delta', text: '先打开**微信**' } })
    await overlay.begin(agent, '打开 微信')
    expect(helper.calls.find(c => c.cmd === 'overlay_show')?.args).toMatchObject({ pet: true, text: '先打开微信' })
    expect(helper.calls.some(c => c.cmd === 'window_cmd' && c.args.op === 'minimize')).toBe(true)
    overlay.stream(agent, { type: 'chunk', chunk: { type: 'reasoning-delta', text: '找群' } })
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(helper.calls.filter(c => c.cmd === 'pet_update').at(-1)?.args).toEqual({ text: '先打开微信', thinking: '找群', steps: ['打开 微信'], thinkingLatest: true })
    await overlay.status('点击 (10, 20)')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(helper.calls.filter(c => c.cmd === 'pet_update').at(-1)?.args).toMatchObject({ steps: ['打开 微信', '点击 (10, 20)'], thinkingLatest: false })
  })

  it('sends instructions typed into the card to the agent, and says done at the end', async () => {
    const helper = new FakeHelper()
    const settings = { ...SETTINGS, hostWindow: 'pet' as const }
    const overlay = new OverlayController(helper, () => settings, () => {})
    const agent = { cancel: () => {} }
    const sent: string[] = []
    overlay.onMessage = (who, text) => { if (who === agent) sent.push(text) }
    overlay.stream(agent, { type: 'start' })
    await overlay.begin(agent, '打开 Word')
    helper.emit({ event: 'message', reason: '保存到 D 盘' })
    expect(sent).toEqual(['保存到 D 盘'])
    await overlay.end(agent)
    expect(helper.calls.some(c => c.cmd === 'pet_finish')).toBe(true)
    expect(helper.calls.some(c => c.cmd === 'overlay_hide')).toBe(false)
  })
})

describe('app skills in tools', () => {
  const store = () => {
    const root = mkdtempSync(join(tmpdir(), 'cu-skills-tools-'))
    mkdirSync(join(root, 'builtin'))
    writeFileSync(join(root, 'builtin', 'chrome.md'), '---\napp: Chrome\nmatch: Chrome, chrome.exe\nsummary: 地址栏\n---\n- ctrl+l 聚焦地址栏\n')
    return new SkillStore(join(root, 'builtin'), join(root, 'user'))
  }

  it('open_application hands over the app skill once per session', async () => {
    const t = setup({ mode: 'allow-all', skills: store() })
    const original = t.helper.call.bind(t.helper)
    t.helper.call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> =>
      cmd === 'focus' ? { ...CHROME, focused: true } as T : original<T>(cmd, args)
    const first = await t.run('open_application', { name: 'Chrome' })
    expect(first.text).toContain('Your skill notes for Chrome')
    expect(first.text).toContain('ctrl+l 聚焦地址栏')
    const second = await t.run('open_application', { name: 'Chrome' })
    expect(second.text).not.toContain('ctrl+l 聚焦地址栏')
  })

  it('app_skill records and reads notes', async () => {
    const skills = store()
    const t = setup({ mode: 'allow-all', skills })
    const saved = await t.run('app_skill', { action: 'append', app: 'Chrome', content: '- ctrl+t 新标签页' })
    expect(saved.text).toContain('Skill for Chrome saved')
    expect((await t.run('app_skill', { action: 'read', app: 'chrome' })).text).toContain('- ctrl+l 聚焦地址栏\n- ctrl+t 新标签页')
    expect((await t.run('app_skill', { action: 'list' })).text).toContain('Chrome — 地址栏')
    await expect(t.run('app_skill', { action: 'write', app: 'Chrome', content: 'x'.repeat(5000) })).rejects.toThrow(/Condense/)
  })
})

describe('one call for a whole sequence', () => {
  const SAVE = { role: 'Button', name: '保存(S)', x: 1000, y: 800, width: 160, height: 60 }

  it('clicks a control by its name, at its centre', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    t.helper.elements = [SAVE, { role: 'Button', name: '取消', x: 1200, y: 800, width: 160, height: 60 }]
    const value = await t.run('computer', { action: 'left_click', target: '保存' })
    const click = t.helper.calls.find(c => c.cmd === 'click')!
    expect([click.args.x, click.args.y]).toEqual([1080, 830])
    expect(value.text).toContain('Button "保存(S)"')
    // Found in the window itself: the slower look through its popups is not needed.
    expect(t.helper.calls.filter(c => c.cmd === 'ui').map(c => c.args.popupsOnly === true)).toEqual([false])
  })

  it('waits for a control that is still appearing', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    let looks = 0
    t.helper.elements = () => (++looks < 5 ? [] : [SAVE])
    await t.run('computer', { action: 'left_click', target: '保存' })
    // Each look reads the window, then its popups, until the control shows up.
    expect(looks).toBe(5)
    expect(t.helper.calls.some(c => c.cmd === 'click')).toBe(true)
  })

  it('names the candidates instead of guessing between two controls', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    t.helper.elements = [SAVE, { ...SAVE, x: 100 }]
    await expect(t.run('computer', { action: 'left_click', target: '保存' })).rejects.toThrow(/matches 2 controls.*@ \(/)
    expect(t.helper.calls.some(c => c.cmd === 'click')).toBe(false)
  })

  it('clicks the named field before typing into it', async () => {
    const t = setup({ typing: 'paste' })
    t.access.grant('s1', ['Chrome'])
    t.helper.elements = [{ role: 'Edit', name: '文件名:', x: 400, y: 600, width: 800, height: 40 }]
    const value = await t.run('computer', { action: 'type', target: '文件名', text: 'a.txt' })
    const order = t.helper.calls.map(c => c.cmd).filter(cmd => cmd === 'click' || cmd === 'type')
    expect(order).toEqual(['click', 'type'])
    expect(value.text).toContain('clicked')
  })

  it('wait until returns as soon as the window is there, and fails with a reason when it never comes', async () => {
    const t = setup()
    const started = Date.now()
    const value = await t.run('computer', { action: 'wait', until: 'window:google chrome', duration: 5 })
    expect(value.text).toContain('is there')
    expect(Date.now() - started).toBeLessThan(1000)
    await expect(t.run('computer', { action: 'wait', until: 'window:记事本', duration: 0.3 })).rejects.toThrow(/Timed out.*window "记事本" to appear/)
  })

  it('counts a dialog that holds the foreground as there, though the window list leaves owned windows out', async () => {
    const t = setup()
    t.helper.foreground = { ...CHROME, hwnd: 77, title: '另存为', className: '#32770' }
    const value = await t.run('computer', { action: 'wait', until: 'window:另存为', duration: 3 })
    expect(value.text).toContain('is there after 0.')
  })

  it('wait until can wait for a control to go away', async () => {
    const t = setup()
    let looks = 0
    t.helper.elements = () => (++looks < 2 ? [SAVE] : [])
    const value = await t.run('computer', { action: 'wait', until: 'target:保存', gone: true, duration: 5 })
    expect(value.text).toContain('is gone')
  })

  it('lets a batch end with a zoom and returns that image', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    const value = await t.run('computer_batch', { actions: [{ action: 'key', text: 'ctrl+l' }, { action: 'zoom', region: [0, 0, 400, 300] }] })
    expect(value.text).toContain('All 2 actions done')
    expect(value.image).toBeDefined()
    expect(t.helper.calls.filter(c => c.cmd === 'screenshot')).toHaveLength(1)
    await expect(t.run('computer_batch', { actions: [{ action: 'zoom', region: [0, 0, 400, 300] }, { action: 'key', text: 'Return' }] })).resolves.toMatchObject({ text: expect.stringContaining('only allowed as the last action') })
  })

  it('can finish a batch with the window text instead of a screenshot', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    t.helper.windowText = { text: '结果：42', length: 5, truncated: false, source: 'text' }
    const value = await t.run('computer_batch', { actions: [{ action: 'key', text: 'Return' }], finish: 'text' })
    expect(value.text).toContain('结果：42')
    expect(value.image).toBeUndefined()
    expect(t.helper.calls.some(c => c.cmd === 'screenshot')).toBe(false)
  })

  it('still shows the screen when a batch that asked for text fails', async () => {
    const t = setup()
    t.access.grant('s1', ['Chrome'])
    t.helper.failOn = 'keys'
    const value = await t.run('computer_batch', { actions: [{ action: 'key', text: 'Return' }], finish: 'text' })
    expect(value.text).toContain('Stopped')
    expect(value.image).toBeDefined()
  })

  it('reads a window as text', async () => {
    const t = setup()
    t.helper.windowText = { text: '最后一段', length: 9000, truncated: true, source: 'text' }
    const value = await t.run('ui_elements', { text: true, tail: 500 })
    expect(value.text).toContain('last 4 of 9000 characters')
    expect(value.text).toContain('最后一段')
    expect(t.helper.calls.find(c => c.cmd === 'text')!.args.tail).toBe(500)
  })
})

describe('sessions that never prompt for approval', () => {
  it('grants the app on open_application instead of sending the model back to request_access', async () => {
    const asking = setup()
    await expect(asking.run('open_application', { name: 'Chrome' })).rejects.toThrow(/not granted/)
    const t = setup({ autoApprove: true })
    const outcome = await t.run('open_application', { name: 'Chrome' }).catch((error: Error) => error)
    expect(outcome instanceof Error ? outcome.message : '').not.toMatch(/not granted/)
    expect(t.access.missing('s1', ['Chrome'])).toEqual([])
  })

  it('still never grants DeepSeek Harness itself', async () => {
    const t = setup({ autoApprove: true })
    await expect(t.run('open_application', { name: 'DeepSeek Harness' })).rejects.toThrow(/not granted/)
  })
})
