/**
 * Model-facing tools. Kept few and terse on purpose: every schema is sent with
 * every request, and the old plugin's ~20 verbose tools cost a lot of tokens.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool, type ToolCallView } from '@deepseek-ai/dsh-tools'
import { appMatches, isHostWindow, isTransientShell, normalizeApp } from './access.js'
import { ACTIONS, Computer, UNCHANGED_TEXT, type ActionInput, type CallContext, type Shot, type WindowInfo } from './computer.js'

type ToolDefinition = ReturnType<typeof defineTool>

export interface ToolHost {
  computer: Computer
  /** Persist an image so the model can see it. */
  saveImage(shot: Shot, name: string): Promise<ImageAttachmentRef>
  /** Build the per-call context (session, agent, vision support). */
  context(exec: unknown): Promise<CallContext>
}

// ----------------------------------------------------------------- output

function attachmentSchema() {
  return {
    type: 'object', additionalProperties: false, properties: {
      attachmentId: { type: 'string', required: true }, mediaType: { type: 'string', required: true }, bytes: { type: 'integer', required: true }, width: { type: 'integer', required: true }, height: { type: 'integer', required: true }, name: { type: 'string' },
      originalDimensions: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', required: true }, height: { type: 'integer', required: true } } },
    },
  } as const
}

interface Value { text: string; image?: AttachmentJson }
interface AttachmentJson { attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string; originalDimensions?: { width: number; height: number } }

const output = {
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true }, image: attachmentSchema() } },
  render: (_args: unknown, value: Value) => value.image === undefined
    ? [{ type: 'text' as const, text: value.text }]
    : [{ type: 'text' as const, text: value.text }, { type: 'image' as const, attachment: value.image as unknown as ImageAttachmentRef }],
} as const

function toJson(ref: ImageAttachmentRef): AttachmentJson {
  return {
    attachmentId: String(ref.attachmentId),
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(ref.name === undefined ? {} : { name: ref.name }),
    ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { width: ref.originalDimensions.width, height: ref.originalDimensions.height } }),
  }
}

async function withShot(host: ToolHost, text: string, shot: Shot | 'unchanged' | undefined, call: CallContext): Promise<Value> {
  if (shot === undefined) return { text }
  if (shot === 'unchanged') return { text: `${text}
${UNCHANGED_TEXT}` }
  if (!call.vision) return { text: `${text}\n(The current model cannot view images; use ui_elements to read the screen.)` }
  const ref = await host.saveImage(shot, 'screenshot.jpg')
  return { text: `${text}\nScreenshot ${shot.width}x${shot.height} attached; use its pixel coordinates for the next actions.`, image: toJson(ref) }
}

function card(title: string): ToolCallView {
  return { card: 'generic', title, kind: 'other' }
}

// ------------------------------------------------------------- parameters

const coordinate = { type: 'array', items: { type: 'number' }, description: '[x, y] in pixels of the latest screenshot.' } as const

const actionProperties = {
  action: { type: 'string', enum: [...ACTIONS], required: true, description: 'What to do.' },
  coordinate,
  start_coordinate: { ...coordinate, description: 'Drag start [x, y] (left_click_drag).' },
  text: { type: 'string', description: 'type: text to enter. key/hold_key: xdotool-style keys, e.g. "ctrl+s", "Return", "alt+Tab", "ctrl+a Delete". Clicks: optional modifier keys like "ctrl".' },
  modifiers: { type: 'string', description: 'Modifier keys held during a click or scroll, e.g. "shift" or "ctrl+shift".' },
  scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
  scroll_amount: { type: 'integer', description: 'Wheel notches (default 3).' },
  duration: { type: 'number', description: 'Seconds for wait / hold_key.' },
  region: { type: 'array', items: { type: 'number' }, description: 'zoom: [x1, y1, x2, y2] in screenshot pixels.' },
} as const

const BATCH_ACTIONS = ACTIONS.filter(action => action !== 'screenshot' && action !== 'zoom')

// ------------------------------------------------------------------ tools

export function createTools(host: ToolHost): ToolDefinition[] {
  const { computer } = host
  const tools: ToolDefinition[] = []

  tools.push(defineTool({
    name: 'computer',
    description: 'Control the Windows desktop with the mouse and keyboard, like a person. Coordinates are pixels of the latest screenshot (the plugin handles DPI and scaling). Clicks, typing, keys, scrolls and wait return a fresh screenshot automatically (taken once the screen settles), so do not call screenshot again right after. Prefer keyboard shortcuts when they are reliable. zoom shows a region at full resolution for small text.',
    parameters: actionProperties,
    output,
    timeoutMs: 30 * 60_000, // a user pause (Esc) holds the call
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const input = args as ActionInput
      try {
        const outcome = await computer.run(input, call)
        if (outcome.image) return withShot(host, outcome.text, outcome.image, call)
        const shot = await computer.after([input], call)
        const text = shot === undefined && input.action !== 'wait' && input.action !== 'cursor_position'
          ? `${outcome.text} ${await computer.describeForeground()}`
          : outcome.text
        return withShot(host, text, shot, call)
      } catch (error) {
        if (call.signal.aborted) await computer.releaseHeld()
        throw error
      }
    },
    presentCall: args => card(`电脑操作 · ${Computer.statusOf(args as ActionInput)}`),
  }))

  tools.push(defineTool({
    name: 'computer_batch',
    description: 'Run several computer actions in order in one call (e.g. click a field, type, press Return), then get one screenshot. Stops at the first failing action. Use it when you are confident about the next few steps; the screen is not re-checked between actions.',
    parameters: {
      actions: {
        type: 'array', required: true, description: 'Ordered actions, same fields as the computer tool (screenshot and zoom are not allowed here).',
        items: { type: 'object', additionalProperties: false, properties: { ...actionProperties, action: { ...actionProperties.action, enum: BATCH_ACTIONS } } },
      },
    },
    output,
    timeoutMs: 30 * 60_000,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const actions = (args as { actions: ActionInput[] }).actions
      if (!Array.isArray(actions) || actions.length === 0) throw new Error('actions must be a non-empty array.')
      if (actions.length > 30) throw new Error('At most 30 actions per batch.')
      const lines: string[] = []
      let failure: string | undefined
      for (const [index, input] of actions.entries()) {
        if (input.action === 'screenshot' || input.action === 'zoom') { failure = `#${index + 1} ${input.action}: not allowed in a batch.`; break }
        try {
          const stepStart = Date.now()
          const outcome = await computer.run(input, call)
          if (outcome.skipped) { failure = `#${index + 1} ${input.action} skipped: the user was typing on the keyboard. Re-check the screen before continuing.`; break }
          lines.push(`#${index + 1} ${outcome.text}`)
          await sleep(60, undefined, { signal: call.signal })
          if (computer.settings().pauseOnUserInput && computer.overlay.userTypedSince(stepStart - 1)) {
            failure = `#${index + 1} done, but the user typed on the keyboard meanwhile; remaining actions stopped. Re-check the screen before continuing.`
            break
          }
        } catch (error) {
          if (call.signal.aborted) { await computer.releaseHeld(); throw error }
          failure = `#${index + 1} ${input.action} failed: ${error instanceof Error ? error.message : String(error)}`
          break
        }
      }
      const done = lines.join('\n')
      const shot = call.vision && computer.settings().autoScreenshot
        ? await computer.settle(call.signal).then(() => computer.freshShot())
        : undefined
      const summary = failure === undefined
        ? `All ${actions.length} actions done.\n${done}`
        : `Stopped: ${failure}${done ? `\nCompleted before it:\n${done}` : ''}\nRemaining actions were skipped.`
      return withShot(host, shot === undefined ? `${summary}\n${await computer.describeForeground()}` : summary, shot, call)
    },
    presentCall: args => card(`电脑操作 · 批量 ${(args as { actions?: unknown[] }).actions?.length ?? 0} 步`),
  }))

  tools.push(defineTool({
    name: 'open_application',
    description: 'Open an app by name (e.g. "Chrome", "记事本", "微信", "Excel"), an .exe path, or a URL, or bring it to the front if it is already running. Faster and more reliable than clicking the taskbar or Start menu. Returns a screenshot.',
    parameters: {
      name: { type: 'string', required: true, description: 'App name as shown in the Start menu, an executable path, or an http(s) URL.' },
    },
    output,
    timeoutMs: 30 * 60_000,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const name = String((args as { name: string }).name ?? '').trim()
      if (name === '') throw new Error('name is required.')
      const settings = computer.settings()
      const isUrl = /^https?:\/\//i.test(name)
      // ms-settings:display and friends open the Settings app.
      const appName = /^ms-settings:/i.test(name) ? '设置' : name
      if (settings.accessMode === 'per-app' && !isUrl && computer.access.missing(call.session, [appName]).length > 0) {
        const running = (await computer.windows()).find(win => appMatches(appName, win))
          ?? (await computer.backgroundApps()).find(win => appMatches(appName, win))
        if (!running || !computer.access.isGranted(call.session, running)) {
          throw new Error(`"${appName}" is not granted for this session. Call request_access with ["${appName}"] first.`)
        }
      }
      await computer.overlay.begin(call.agent, `打开 ${name}`)
      await computer.overlay.yieldToUser(call.signal, false)
      const before = await computer.foreground()
      let how: string
      const isUri = isUrl || /^[a-z][a-z0-9+.-]+:(?![\/])/i.test(name)
      const running = isUri ? undefined : (await computer.windows()).find(win => !isHostWindow(win) && appMatches(name, win))
      // Closed to the system tray (QQ, 微信...): click its tray icon like the user
      // would. Launching it again starts a second instance (a second login).
      const hidden = running || isUri ? undefined : (await computer.backgroundApps()).find(win => !isHostWindow(win) && appMatches(name, win))
      if (running) {
        const result = await computer.focus(running)
        how = result.focused ? `Brought ${running.exe} ("${running.title.slice(0, 60)}") to the front.` : `Tried to bring ${running.exe} to the front, but Windows kept another window focused.`
      } else if (hidden) {
        const restored = await computer.helper.call<{ icon: boolean; window?: WindowInfo & { focused: boolean } }>('tray_restore', { exe: hidden.exe }, 20_000)
        how = restored.window
          ? `${hidden.exe} was already running in the system tray: restored its window from the tray icon (no second instance started).`
          : `${hidden.exe} is already running in the background${restored.icon ? ' (system tray)' : ''}, but its window did not come back automatically. Open it from its notification-area icon (click ^ "show hidden icons" on the taskbar first). Do not launch it again (that starts a second instance and login), and never force its hidden window visible from a shell (Electron / Qt apps freeze).`
      } else {
        const apps = isUri ? [] : await computer.helper.call<Array<{ name: string; id: string }>>('apps', { query: name, limit: 5 }, 30_000)
        const app = apps[0]
        if (app) await computer.helper.call('launch', { appId: app.id })
        else await computer.helper.call('launch', { target: name })
        how = app ? `Launched "${app.name}".` : isUrl ? `Opened ${name} in the default browser.` : `Started "${name}".`
        // Wait for the new window to take the foreground. Explorer's desktop and
        // taskbar do not count, but a File Explorer window (CabinetWClass) does.
        for (let i = 0; i < 32; i++) {
          await sleep(250, undefined, { signal: call.signal })
          const now = await computer.foreground()
          if (now && now.hwnd !== before?.hwnd && !isHostWindow(now) && !isTransientShell(now) && (now.exe.toLowerCase() !== 'explorer.exe' || now.className === 'CabinetWClass')) break
        }
      }
      const fg = await computer.foreground()
      // The user approved this app by name; remember which executable it turned out to be.
      if (fg && !isHostWindow(fg) && settings.accessMode === 'per-app' && (computer.access.missing(call.session, [appName]).length === 0 || isUrl)) {
        computer.access.grant(call.session, [fg.exe])
      }
      await computer.settle(call.signal)
      const shot = call.vision ? await computer.screenshot() : undefined
      return withShot(host, `${how} ${await computer.describeForeground()}`, shot, call)
    },
    presentCall: args => card(`打开应用 · ${(args as { name?: string }).name ?? ''}`),
  }))

  tools.push(defineTool({
    name: 'windows',
    description: 'List top-level windows (with process .exe names), or focus / minimize / maximize / restore / close one. Use it to find the right window instead of guessing from titles; the "DeepSeek Harness.exe" window is your own chat UI.',
    parameters: {
      action: { type: 'string', enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close'], required: true },
      hwnd: { type: 'integer', description: 'Window handle from list.' },
      name: { type: 'string', description: 'Alternative to hwnd: exe or title fragment.' },
    },
    output,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const { action, hwnd, name } = args as { action: string; hwnd?: number; name?: string }
      const rows = await computer.windows()
      if (action === 'list') {
        const lines = await Promise.all(rows.map(async win => `hwnd=${win.hwnd} | ${win.exe} | "${win.title.slice(0, 70)}"${win.foreground ? ' | FOREGROUND' : ''}${win.minimized ? ' | minimized' : ` | ${await computer.windowBox(win)}`}${isHostWindow(win) ? ' | (your own DeepSeek Harness chat window)' : ''}`))
        const tray = (await computer.backgroundApps()).filter(win => win.tray && !isHostWindow(win))
        if (tray.length > 0) lines.push(`Running in the system tray without a window (open_application restores them; never relaunch them): ${tray.map(win => `${win.exe} ("${win.title.slice(0, 30)}")`).join(', ')}`)
        return { text: lines.join('\n') || 'No windows.' }
      }
      const target = hwnd !== undefined
        ? rows.find(win => win.hwnd === hwnd)
        // By name: the program first, then a title match; DeepSeek Harness's own
        // window (whose title often quotes the task, e.g. "用 Chrome 打开…") last.
        : name ? rows.find(win => !isHostWindow(win) && appMatches(name, win))
          ?? rows.find(win => !isHostWindow(win) && win.title.toLowerCase().includes(name.toLowerCase()))
          ?? rows.find(win => appMatches(name, win)) : undefined
      if (!target) throw new Error('Window not found; call windows with action "list". An app closed to the system tray has no window: bring it back with open_application.')
      const settings = computer.settings()
      const denial = computer.access.denial(call.session, target, settings.accessMode, settings.blockedApps, action)
      // Minimizing is harmless and reversible: allowed for any window, so you can clear what is in the way.
      if (denial && action !== 'minimize') throw new Error(denial)
      await computer.overlay.begin(call.agent, `窗口 ${action}`)
      await computer.overlay.yieldToUser(call.signal, false)
      let text: string
      if (action === 'focus') {
        const result = await computer.focus(target)
        text = result.focused ? `Focused ${target.exe} ("${target.title.slice(0, 60)}").` : `Windows refused to focus ${target.exe}; try clicking it.`
      } else {
        await computer.helper.call('window_cmd', { hwnd: target.hwnd, op: action })
        text = `${action} ${target.exe} ("${target.title.slice(0, 60)}") done.`
      }
      const shot = await computer.after([{ action: 'key' }], call)
      return withShot(host, shot ? text : `${text} ${await computer.describeForeground()}`, shot, call)
    },
    presentCall: args => card(`窗口 · ${(args as { action?: string }).action ?? ''}`),
  }))

  tools.push(defineTool({
    name: 'ui_elements',
    description: 'List clickable/editable UI elements of the foreground window (or a window by hwnd) from Windows UI Automation, with center coordinates in screenshot pixels. Useful to click precisely, read values, or work without vision. Some apps (games, canvas UIs) expose little.',
    parameters: {
      hwnd: { type: 'integer', description: 'Window handle; default foreground window.' },
      include_text: { type: 'boolean', description: 'Also list static text elements.' },
      max: { type: 'integer', description: 'Max elements (default 120).' },
    },
    output,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args): Promise<Value> {
      const { hwnd, include_text: includeText, max } = args as { hwnd?: number; include_text?: boolean; max?: number }
      const result = await computer.helper.call<WindowInfo & { elements: Array<{ role: string; name: string; value?: string; checked?: boolean; disabled?: boolean; x: number; y: number; width: number; height: number }> }>('ui', {
        ...(hwnd === undefined ? {} : { hwnd }), includeText: includeText === true, maxNodes: Math.min(400, Math.max(10, max ?? 120)),
      }, 20_000)
      const lines: string[] = []
      for (const [index, el] of result.elements.entries()) {
        const center = await computer.toModel({ x: el.x + el.width / 2, y: el.y + el.height / 2 })
        const flags = [el.value !== undefined ? `value="${el.value}"` : '', el.checked !== undefined ? (el.checked ? 'checked' : 'unchecked') : '', el.disabled ? 'disabled' : '', center.offscreen ? 'other display' : ''].filter(Boolean).join(' ')
        lines.push(`[${index}] ${el.role} "${el.name}" @ (${center.x}, ${center.y})${flags ? ` ${flags}` : ''}`)
      }
      const head = `${result.exe} — "${String(result.title ?? '').slice(0, 80)}": ${result.elements.length} elements.`
      return { text: lines.length ? `${head}\n${lines.join('\n')}` : `${head} This window exposes no UI Automation elements; rely on screenshots.` }
    },
    presentCall: () => card('读取界面元素'),
  }))

  tools.push(defineTool({
    name: 'clipboard',
    description: 'Read or write the clipboard text. Writes stay out of Windows clipboard history, and the user clipboard is restored when you finish. To enter long text, prefer computer type (it pastes for you); never set the clipboard from a shell.',
    parameters: {
      action: { type: 'string', enum: ['read', 'write'], required: true },
      text: { type: 'string', description: 'Text to write.' },
    },
    output,
    async execute(args, exec): Promise<Value> {
      const { action, text } = args as { action: 'read' | 'write'; text?: string }
      if (action === 'write') {
        computer.clipboardAgent = (await host.context(exec)).agent
        await computer.helper.call('clipboard_set', { text: text ?? '', agent: true })
        return { text: `Clipboard set (${(text ?? '').length} characters).` }
      }
      const result = await computer.helper.call<{ text: string }>('clipboard_get')
      return { text: result.text === '' ? 'Clipboard has no text.' : `Clipboard text:\n${result.text.slice(0, 20_000)}` }
    },
    presentCall: args => card(`剪贴板 · ${(args as { action?: string }).action === 'write' ? '写入' : '读取'}`),
  }))

  tools.push(defineTool({
    name: 'switch_display',
    description: 'List displays or switch which display screenshots and coordinates refer to (multi-monitor setups).',
    parameters: {
      index: { type: 'integer', description: 'Display index to switch to; omit to just list.' },
    },
    output,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const { index } = args as { index?: number }
      if (index !== undefined) await computer.selectDisplay(index)
      const rows = await computer.refreshDisplays()
      const list = rows.map((d, i) => `${i}: ${d.width}x${d.height} at (${d.x}, ${d.y}), ${Math.round(d.dpi / 96 * 100)}% scale${d.primary ? ', primary' : ''}${i === computer.currentIndex ? ' ← current' : ''}`).join('\n')
      if (index === undefined) return { text: list }
      const shot = call.vision ? await computer.screenshot() : undefined
      return withShot(host, `Switched to display ${index}.\n${list}`, shot, call)
    },
    presentCall: () => card('切换显示器'),
  }))

  tools.push(defineTool({
    name: 'request_access',
    description: 'Ask the user to let you control specific apps in this session (they approve in DeepSeek Harness). Call it before acting on an app, listing every app the task needs, e.g. ["Chrome", "记事本"]. Input to apps that are not granted is refused.',
    parameters: {
      apps: { type: 'array', items: { type: 'string' }, required: true, description: 'App names (Start-menu names or .exe names).' },
      reason: { type: 'string', description: 'One sentence on why, shown to the user.' },
    },
    output,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const apps = ((args as { apps: string[] }).apps ?? []).map(String).filter(app => app.trim() !== '')
      if (apps.length === 0) throw new Error('apps must list at least one app.')
      if (computer.settings().accessMode === 'allow-all') {
        return { text: 'Access mode is "allow all": every app except DeepSeek Harness and blocked apps can be controlled. No approval needed.' }
      }
      if (apps.some(app => normalizeApp(app).includes('deepseek harness'))) throw new Error('DeepSeek Harness itself cannot be controlled.')
      computer.access.grant(call.session, apps)
      return { text: `Granted for this session: ${computer.access.granted(call.session).join(', ')}. Open or focus them with open_application.` }
    },
    presentCall: args => card(`请求操控 · ${((args as { apps?: string[] }).apps ?? []).join('、')}`),
  }))

  tools.push(defineTool({
    name: 'list_granted_applications',
    description: 'List the apps you may control in this session.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec): Promise<Value> {
      const call = await host.context(exec)
      if (computer.settings().accessMode === 'allow-all') return { text: 'Access mode is "allow all": every app except DeepSeek Harness and blocked apps.' }
      const granted = computer.access.granted(call.session)
      return { text: granted.length ? `Granted: ${granted.join(', ')}` : 'Nothing granted yet; call request_access.' }
    },
    presentCall: () => card('已授权应用'),
  }))

  return tools
}
