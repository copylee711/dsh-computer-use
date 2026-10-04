/**
 * Model-facing tools. Kept few and terse on purpose: every schema is sent with
 * every request, and the old plugin's ~20 verbose tools cost a lot of tokens.
 */
import { setTimeout as sleep } from 'node:timers/promises'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { defineTool, type ToolCallView } from '@deepseek-ai/dsh-tools'
import { appMatches, isHostWindow, isTransientShell, normalizeApp } from './access.js'
import { SKILL_MAX_CHARS, type SkillStore } from './skills.js'
import { ACTIONS, Computer, UNCHANGED_TEXT, type ActionInput, type CallContext, type Shot, type WindowInfo } from './computer.js'

type ToolDefinition = ReturnType<typeof defineTool>

export interface ToolHost {
  computer: Computer
  /** Persist an image so the model can see it. */
  saveImage(shot: Shot, name: string): Promise<ImageAttachmentRef>
  /** Build the per-call context (session, agent, vision support). */
  context(exec: unknown): Promise<CallContext>
  /** Per-app notes the agent keeps (optional: tests run without). */
  skills?: SkillStore
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

/** windows list notes about the layout before the task. */
const ORIGIN: Record<string, string> = {
  opened: ' | opened during this task',
  minimized: ' | was minimized before this task',
  tray: ' | was in the system tray before this task',
}

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

/** Reads what a window says through UI Automation: exact text, no image. */
async function windowText(computer: Computer, hwnd: number | undefined, tail: number | undefined): Promise<string> {
  const result = await computer.helper.call<WindowInfo & { text: string; length: number; truncated: boolean; source: string }>('text', {
    ...(hwnd === undefined ? {} : { hwnd }), tail: Math.min(20_000, Math.max(200, Math.round(tail ?? 4000))),
  }, 20_000)
  const head = `${result.exe} — "${String(result.title ?? '').slice(0, 80)}"`
  if (!result.text || result.source === 'none') return `${head}: this window exposes no readable text; use a screenshot.`
  const part = result.truncated ? `last ${result.text.length} of ${result.length} characters` : `${result.length} characters`
  return `${head}: ${part}${result.source === 'labels' ? ' (visible labels, top to bottom)' : ''}.\n${result.text}`
}

const actionProperties = {
  action: { type: 'string', enum: [...ACTIONS], required: true, description: 'What to do.' },
  coordinate,
  start_coordinate: { ...coordinate, description: 'Drag start [x, y] (left_click_drag).' },
  text: { type: 'string', description: 'type: text to enter. key/hold_key: xdotool-style keys, e.g. "ctrl+s", "Return", "alt+Tab", "ctrl+a Delete". Clicks: optional modifier keys like "ctrl".' },
  modifiers: { type: 'string', description: 'Modifier keys held during a click or scroll, e.g. "shift" or "ctrl+shift".' },
  scroll_direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
  scroll_amount: { type: 'integer', description: 'Wheel notches (default 3).' },
  duration: { type: 'number', description: 'Seconds for wait / hold_key (with until: the timeout, default 10).' },
  target: { type: 'string', description: 'Instead of coordinate: the visible name of a control in the foreground window or its open menu, e.g. "保存" or "按钮:保存". Works for controls that were not in your last screenshot (the item of a menu the previous step opens); waits up to 3 s for it. With type: clicks the field first.' },
  until: { type: 'string', description: 'wait: return as soon as this is there, "window:<title or exe part>" or "target:<control name>", instead of waiting a fixed time.' },
  gone: { type: 'boolean', description: 'wait until: wait for it to disappear instead.' },
  region: { type: 'array', items: { type: 'number' }, description: 'zoom: [x1, y1, x2, y2] in screenshot pixels.' },
} as const

const BATCH_ACTIONS = ACTIONS.filter(action => action !== 'screenshot')

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
    description: 'Run several computer actions in order in one call, then get one screenshot (taken once the screen settles, so do not end with a wait). Stops at the first failing action and shows you the screen. The screen is not shown to you between actions, so for steps whose target only appears along the way (a menu item, a dialog button) use target instead of coordinate, and wait with until for a window or control to appear. Example: [key "ctrl+s", wait until "window:另存为", type target "文件名" text "C:\\a.txt", left_click target "保存"].',
    parameters: {
      actions: {
        type: 'array', required: true, description: 'Ordered actions, same fields as the computer tool. zoom is allowed only as the last action (you get the zoomed region instead of the full screenshot).',
        items: { type: 'object', additionalProperties: false, properties: { ...actionProperties, action: { ...actionProperties.action, enum: BATCH_ACTIONS } } },
      },
      finish: { type: 'string', enum: ['screenshot', 'text', 'none'], description: 'What to return after the actions: screenshot (default), text (what the foreground window says, read as text: cheaper and exact when you only need the words), or none.' },
    },
    output,
    timeoutMs: 30 * 60_000,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const actions = (args as { actions: ActionInput[] }).actions
      const finish = (args as { finish?: string }).finish ?? 'screenshot'
      let zoomed: Shot | undefined
      if (!Array.isArray(actions) || actions.length === 0) throw new Error('actions must be a non-empty array.')
      if (actions.length > 30) throw new Error('At most 30 actions per batch.')
      const lines: string[] = []
      let failure: string | undefined
      for (const [index, input] of actions.entries()) {
        if (input.action === 'screenshot' || (input.action === 'zoom' && index !== actions.length - 1)) {
          failure = `#${index + 1} ${input.action}: ${input.action === 'zoom' ? 'only allowed as the last action of a batch' : 'not allowed in a batch'}.`
          break
        }
        try {
          const stepStart = Date.now()
          // The zoom is of what the earlier actions left on screen, once it has settled.
          if (input.action === 'zoom' && index > 0) await computer.settle(call.signal)
          const outcome = await computer.run(input, call)
          if (input.action === 'zoom') zoomed = outcome.image
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
      const summary = failure === undefined
        ? `All ${actions.length} actions done.\n${done}`
        : `Stopped: ${failure}${done ? `\nCompleted before it:\n${done}` : ''}\nRemaining actions were skipped.`
      if (zoomed !== undefined && failure === undefined) return withShot(host, summary, zoomed, call)
      // A failed batch always shows the screen: the model has to see where it stopped.
      if (failure === undefined && finish === 'none') return { text: `${summary}\n${await computer.describeForeground()}` }
      if (failure === undefined && finish === 'text') {
        await computer.settle(call.signal)
        return { text: `${summary}\n${await windowText(computer, undefined, undefined).catch(error => `Could not read the window text: ${error instanceof Error ? error.message : String(error)}`)}` }
      }
      // A batch that ends with a wait has already waited for the screen: do not wait a second time.
      const waited = failure === undefined && actions[actions.length - 1]?.action === 'wait'
      const shot = call.vision && computer.settings().autoScreenshot
        ? await (waited ? Promise.resolve() : computer.settle(call.signal)).then(() => computer.freshShot())
        : undefined
      return withShot(host, shot === undefined ? `${summary}\n${await computer.describeForeground()}` : summary, shot, call)
    },
    presentCall: args => card(`电脑操作 · 批量 ${(args as { actions?: unknown[] }).actions?.length ?? 0} 步`),
  }))

  tools.push(defineTool({
    name: 'open_application',
    description: 'Open an app by name (e.g. "Chrome", "记事本", "微信", "Excel"), an .exe path, or a URL, or bring it to the front if it is already running. Faster and more reliable than clicking the taskbar or Start menu. Returns a screenshot.',
    parameters: {
      name: { type: 'string', required: true, description: 'App name as shown in the Start menu, an executable path, or an http(s) URL.' },
      new_instance: { type: 'boolean', description: 'Start another copy even though the app is already running. Only when the user explicitly asks for a second window / instance / account.' },
    },
    output,
    timeoutMs: 30 * 60_000,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const text = await openApp(String((args as { name: string }).name ?? ''), (args as { new_instance?: boolean }).new_instance === true, call)
      await computer.settle(call.signal)
      const shot = call.vision ? await computer.screenshot() : undefined
      return withShot(host, text, shot, call)
    },
    presentCall: args => card(`打开应用 · ${(args as { name?: string }).name ?? ''}`),
  }))

  /** Open an app or bring it forward; returns what happened, the foreground window and the app's skill notes. */
  async function openApp(rawName: string, newInstance: boolean, call: CallContext): Promise<string> {
    {
      const name = rawName.trim()
      if (name === '') throw new Error('name is required.')
      const settings = computer.settings()
      const isUrl = /^https?:\/\//i.test(name)
      // ms-settings:display and friends open the Settings app.
      const appName = /^ms-settings:/i.test(name) ? '设置' : name
      if (settings.accessMode === 'per-app' && !isUrl && computer.access.missing(call.session, [appName]).length > 0) {
        const running = (await computer.windows()).find(win => appMatches(appName, win))
          ?? (await computer.backgroundApps(false)).find(win => appMatches(appName, win))
        if (!running || !computer.access.isGranted(call.session, running)) {
          // A session that never prompts would have this request approved without asking:
          // grant it here instead of costing the model a failed call and a request_access round.
          if (call.autoApprove !== true || normalizeApp(appName).includes('deepseek harness')) {
            throw new Error(`"${appName}" is not granted for this session. Call request_access with ["${appName}"] first.`)
          }
          computer.access.grant(call.session, [appName])
        }
      }
      await computer.overlay.begin(call.agent, `打开 ${name}`)
      await computer.overlay.yieldToUser(call.signal, false)
      const before = await computer.foreground()
      let how: string
      const isUri = isUrl || /^[a-z][a-z0-9+.-]+:(?![\/])/i.test(name)
      const running = isUri || newInstance ? undefined : (await computer.windows()).find(win => !isHostWindow(win) && appMatches(name, win))
      // Closed to the system tray (QQ, 微信...): click its tray icon like the user
      // would. Launching it again starts a second instance (a second login).
      const hidden = running || isUri || newInstance ? undefined : (await computer.backgroundApps(false)).find(win => !isHostWindow(win) && appMatches(name, win))
      if (running) {
        const result = await computer.focus(running)
        how = result.focused ? `Brought ${running.exe} ("${running.title.slice(0, 60)}") to the front.` : `Tried to bring ${running.exe} to the front, but Windows kept another window focused.`
      } else if (hidden) {
        const restored = await computer.helper.call<{ icon: boolean; window?: WindowInfo & { focused: boolean } }>('tray_restore', { exe: hidden.exe }, 20_000)
        if (restored.window) computer.noteFromTray(restored.window.hwnd)
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
        for (let i = 0; i < 80; i++) {
          await sleep(100, undefined, { signal: call.signal })
          const now = await computer.foreground()
          if (now && now.hwnd !== before?.hwnd && !isHostWindow(now) && !isTransientShell(now) && (now.exe.toLowerCase() !== 'explorer.exe' || now.className === 'CabinetWClass')) break
          // The app's window is up but something transient (the IME bar) holds the foreground: bring it forward.
          if (i >= 10 && i % 10 === 0 && !isUri) {
            const opened = (await computer.windows()).find(win => !isHostWindow(win) && appMatches(name, win))
            if (opened) { await computer.focus(opened).catch(() => undefined); break }
          }
        }
      }
      const fg = await computer.foreground()
      // The user approved this app by name; remember which executable it turned out to be.
      if (fg && !isHostWindow(fg) && settings.accessMode === 'per-app' && (computer.access.missing(call.session, [appName]).length === 0 || isUrl)) {
        computer.access.grant(call.session, [fg.exe])
      }
      return `${how} ${await computer.describeForeground()}${skillNote(call.session, name, fg)}`
    }
  }

  /** Skills already handed to a session, so each is attached once. */
  const told = new Map<string, Set<string>>()

  /** The app's skill, appended to open_application's result the first time in a session. */
  function skillNote(session: string, name: string, win: WindowInfo | undefined): string {
    const skill = host.skills?.find(name, win && !isHostWindow(win) ? win : undefined)
    if (!skill) return host.skills ? '\n(No app skill for this app yet: if you have to work out how it behaves, record the reusable part with app_skill append when you are done.)' : ''
    let seen = told.get(session)
    if (!seen) told.set(session, seen = new Set())
    if (seen.has(skill.id)) return ''
    seen.add(skill.id)
    return `\n\nYour skill notes for ${skill.app} (app_skill; correct them if they turn out wrong):\n${skill.content}`
  }

  /** Put back what the task changed: re-minimize restored windows, report the ones it opened. */
  async function tidy(call: CallContext): Promise<Value> {
    await computer.overlay.begin(call.agent, '整理窗口')
    const rows = (await computer.windows()).filter(win => !isHostWindow(win))
    const minimized: string[] = []
    for (const win of rows) {
      const origin = computer.origin(win)
      if (origin !== 'minimized' && origin !== 'tray') continue
      await computer.helper.call('window_cmd', { hwnd: win.hwnd, op: 'minimize' }).catch(() => {})
      minimized.push(`${win.exe} ("${win.title.slice(0, 40)}")`)
    }
    const opened = rows.filter(win => computer.origin(win) === 'opened')
    const lines = [
      minimized.length ? `Minimized again (they were minimized or in the tray before): ${minimized.join(', ')}.` : 'Nothing to minimize again.',
      opened.length
        ? `Opened during this task, still open:\n${opened.map(win => `hwnd=${win.hwnd} | ${win.exe} | "${win.title.slice(0, 60)}"`).join('\n')}\nClose the ones the user does not need (windows close); keep any that shows the result they asked for.`
        : 'No windows opened during this task are left.',
    ]
    return { text: lines.join('\n') }
  }

  tools.push(defineTool({
    name: 'windows',
    description: 'List top-level windows (with process .exe names), or focus / minimize / maximize / restore / close one. Use it to find the right window instead of guessing from titles; the "DeepSeek Harness.exe" window is your own chat UI.',
    parameters: {
      action: { type: 'string', enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close', 'tidy'], required: true, description: 'tidy: when the task is done, minimize again every window that was minimized or in the system tray before you started, and list the windows you opened.' },
      hwnd: { type: 'integer', description: 'Window handle from list.' },
      name: { type: 'string', description: 'Alternative to hwnd: exe or title fragment.' },
    },
    output,
    async execute(args, exec): Promise<Value> {
      const call = await host.context(exec)
      const { action, hwnd, name } = args as { action: string; hwnd?: number; name?: string }
      const rows = await computer.windows()
      if (action === 'list') {
        const lines = await Promise.all(rows.map(async win => `hwnd=${win.hwnd} | ${win.exe} | "${win.title.slice(0, 70)}"${win.foreground ? ' | FOREGROUND' : ''}${win.minimized ? ' | minimized' : ` | ${await computer.windowBox(win)}`}${isHostWindow(win) ? ' | (your own DeepSeek Harness chat window)' : ''}${ORIGIN[computer.origin(win) ?? ''] ?? ''}`))
        const tray = (await computer.backgroundApps()).filter(win => win.tray && !isHostWindow(win))
        if (tray.length > 0) lines.push(`Running in the system tray without a window (open_application restores them; never relaunch them): ${tray.map(win => `${win.exe} ("${win.title.slice(0, 30)}")`).join(', ')}`)
        return { text: lines.join('\n') || 'No windows.' }
      }
      if (action === 'tidy') return tidy(call)
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
    presentCall: args => card((args as { action?: string }).action === 'tidy' ? '整理窗口' : `窗口 · ${(args as { action?: string }).action ?? ''}`),
  }))

  tools.push(defineTool({
    name: 'ui_elements',
    description: 'Read the foreground window (or a window by hwnd) through Windows UI Automation. Default: its clickable/editable elements with center coordinates in screenshot pixels (to click precisely, read values, or work without vision). With text: true: what the window says as plain text (a document, a web page, a chat reply, a log) — exact and far cheaper than scrolling and zooming screenshots. Some apps (games, canvas UIs) expose little.',
    parameters: {
      hwnd: { type: 'integer', description: 'Window handle; default foreground window.' },
      text: { type: 'boolean', description: 'Return the window\'s text content instead of the element list.' },
      tail: { type: 'integer', description: 'text: how many characters from the end to return (default 4000, max 20000); new content is usually at the end.' },
      include_text: { type: 'boolean', description: 'Also list static text elements.' },
      max: { type: 'integer', description: 'Max elements (default 120).' },
    },
    output,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args): Promise<Value> {
      const { hwnd, include_text: includeText, max, text, tail } = args as { hwnd?: number; include_text?: boolean; max?: number; text?: boolean; tail?: number }
      if (text === true) return { text: await windowText(computer, hwnd, tail) }
      const result = await computer.helper.call<WindowInfo & { elements: Array<{ role: string; name: string; value?: string; checked?: boolean; disabled?: boolean; x: number; y: number; width: number; height: number }> }>('ui', {
        ...(hwnd === undefined ? {} : { hwnd }), includeText: includeText === true, popups: true, maxNodes: Math.min(400, Math.max(10, max ?? 120)),
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

  if (host.skills) {
    const skills = host.skills
    tools.push(defineTool({
      name: 'app_skill',
      description: `Your notes on how to operate specific apps (one skill per app, kept across sessions; the user can edit them). open_application already returns the skill of the app it opens. Use "list" to see which apps have one, "read" for an app you reach another way, and "append" / "write" to record what you worked out about an unfamiliar app: reusable operating knowledge only (where things are, shortcuts, quirks, what failed and what works), never task content, personal data or pixel coordinates (they change with the window). Keep each skill under ${SKILL_MAX_CHARS} characters; rewrite it with "write" when it gets long or wrong.`,
      parameters: {
        action: { type: 'string', enum: ['list', 'read', 'append', 'write'], required: true },
        app: { type: 'string', description: 'App name, e.g. "Obsidian" (read / append / write).' },
        content: { type: 'string', description: 'Markdown bullet points: the lines to add (append) or the whole skill (write).' },
        summary: { type: 'string', description: 'A few words on what the skill covers, shown in the list (write, or the first append).' },
      },
      output,
      isConcurrencySafe: () => false,
      async execute(args): Promise<Value> {
        const { action, app, content, summary } = args as { action: string; app?: string; content?: string; summary?: string }
        if (action === 'list') {
          const rows = skills.list()
          return { text: rows.length === 0 ? 'No app skills yet.' : rows.map(skill => `${skill.app}${skill.summary ? ` — ${skill.summary}` : ''} (${skill.content.length} chars)`).join('\n') }
        }
        const name = String(app ?? '').trim()
        if (name === '') throw new Error('app is required.')
        if (action === 'read') {
          const skill = skills.find(name, await computer.foreground().catch(() => undefined))
          return { text: skill ? `Skill for ${skill.app}:\n${skill.content}` : `No skill for "${name}" yet. If you work out how this app behaves, record it with app_skill append.` }
        }
        const text = String(content ?? '').trim()
        if (text === '') throw new Error('content is required.')
        // Remember which executable the app is, so the skill is found by window later.
        const fg = await computer.foreground().catch(() => undefined)
        // (UWP apps all run as ApplicationFrameHost.exe: that name would match every one of them.)
        const match = fg && !isHostWindow(fg) && appMatches(name, fg) && !/^applicationframehost/i.test(fg.exe) ? [fg.exe] : []
        const extra = { match, ...(summary ? { summary } : {}) }
        const saved = action === 'write' ? skills.save({ app: name, content: text, ...extra }, skills.find(name)?.id) : skills.append(name, text, extra)
        return { text: `Skill for ${saved.app} saved (${saved.content.length} of ${SKILL_MAX_CHARS} characters).` }
      },
      presentCall: args => card(`应用技能 · ${({ list: '列表', read: '读取', append: '记录', write: '重写' } as Record<string, string>)[(args as { action?: string }).action ?? ''] ?? ''}${(args as { app?: string }).app ? ` · ${(args as { app?: string }).app}` : ''}`),
    }))
  }

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
