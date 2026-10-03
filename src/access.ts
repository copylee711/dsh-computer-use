/**
 * Per-session application grants, modelled on Claude's computer use: the
 * model asks for named apps with request_access, the user approves through
 * DSH's own approval prompt, and input is only delivered to granted apps.
 * The DSH window itself and configured blocked apps are never controllable.
 */

export type AccessMode = 'per-app' | 'allow-all'

export interface WindowLike {
  exe: string
  title: string
}

/** The DSH desktop host: the agent must never type into its own chat. */
export const HOST_EXES = ['deepseek harness.exe']

/** Common Chinese / product names → executable base names. */
const ALIASES: Record<string, string[]> = {
  '记事本': ['notepad'], 'notepad': ['notepad'],
  '计算器': ['calculatorapp', 'calc', 'applicationframehost'], 'calculator': ['calculatorapp', 'calc', 'applicationframehost'],
  '画图': ['mspaint'], 'paint': ['mspaint'],
  '文件资源管理器': ['explorer'], '资源管理器': ['explorer'], '文件管理器': ['explorer'], 'file explorer': ['explorer'], 'finder': ['explorer'],
  '任务栏': ['explorer'], '桌面': ['explorer'], 'desktop': ['explorer'], 'taskbar': ['explorer'],
  '开始菜单': ['startmenuexperiencehost', 'searchhost'], 'start menu': ['startmenuexperiencehost', 'searchhost'],
  '设置': ['systemsettings', 'applicationframehost'], 'settings': ['systemsettings', 'applicationframehost'],
  '谷歌浏览器': ['chrome'], 'google chrome': ['chrome'], 'chrome': ['chrome'],
  'edge': ['msedge'], 'microsoft edge': ['msedge'], '浏览器': ['chrome', 'msedge', 'firefox'],
  'firefox': ['firefox'], '火狐': ['firefox'],
  '微信': ['weixin', 'wechat'], 'wechat': ['weixin', 'wechat'], 'qq': ['qq'], '钉钉': ['dingtalk'], '飞书': ['feishu', 'lark'],
  'vs code': ['code'], 'vscode': ['code'], 'visual studio code': ['code'],
  '终端': ['windowsterminal', 'wt'], 'terminal': ['windowsterminal', 'wt'], 'windows terminal': ['windowsterminal'],
  'powershell': ['powershell', 'pwsh'], '命令提示符': ['cmd'], 'cmd': ['cmd'],
  'word': ['winword'], 'excel': ['excel'], 'powerpoint': ['powerpnt'], 'ppt': ['powerpnt'], 'outlook': ['outlook', 'olk'],
  'wps': ['wps', 'et', 'wpp'], '任务管理器': ['taskmgr'], 'task manager': ['taskmgr'],
  '截图工具': ['snippingtool'], 'snipping tool': ['snippingtool'], '照片': ['photos', 'applicationframehost'], 'photos': ['photos'],
}

const DEFAULT_BLOCKED = ['1password', 'bitwarden', 'keepass', 'keepassxc', 'lastpass', 'dashlane', 'enpass', 'nordpass', 'proton pass']

export function normalizeApp(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, '').replace(/\s+/g, ' ')
}

function exeBase(win: WindowLike): string {
  return normalizeApp(win.exe.split(/[\\/]/).pop() ?? '')
}

/** Executable names an app name stands for (UWP's shared frame host excluded). */
function exeNames(name: string): Set<string> {
  const n = normalizeApp(name)
  return new Set([n.replace(/\s/g, ''), ...(ALIASES[n] ?? [])].filter(exe => exe !== 'applicationframehost'))
}

/** Do two app names refer to the same program ("explorer" and "文件资源管理器")? */
export function sameApp(a: string, b: string): boolean {
  const x = exeNames(a)
  for (const exe of exeNames(b)) if (x.has(exe)) return true
  return false
}

/**
 * Windows shell surfaces that grab the foreground without being a place to
 * work: the touch-keyboard / IME host and Snap Assist.
 */
export function isTransientShell(win: WindowLike & { className?: string }): boolean {
  const exe = win.exe.toLowerCase()
  // The IME candidate window, and our own instruction box on the progress card.
  if (exe === 'textinputhost.exe' || exe === 'cu-helper.exe') return true
  return exe === 'explorer.exe' && (win.className === 'XamlExplorerHostIslandWindow' || /贴靠助手|snap assist/i.test(win.title))
}

export function isHostWindow(win: WindowLike): boolean {
  return HOST_EXES.includes(win.exe.toLowerCase())
}

/** Does a granted (or requested) app name refer to this window? */
export function appMatches(name: string, win: WindowLike): boolean {
  const g = normalizeApp(name)
  const exe = exeBase(win)
  if (g === '' || exe === '') return false
  const compactG = g.replace(/\s/g, '')
  if (exe === g || exe === compactG) return true
  const aliases = ALIASES[g]
  if (aliases?.includes(exe) && exe !== 'applicationframehost') return true
  if (exe.length >= 3 && compactG.includes(exe)) return true
  if (compactG.length >= 3 && exe.includes(compactG)) return true
  // UWP apps all run as ApplicationFrameHost.exe: fall back to the window title.
  if (exe === 'applicationframehost') {
    const title = win.title.toLowerCase()
    return title.includes(g) || (aliases?.some(alias => title.includes(alias)) ?? false)
  }
  return false
}

export class AccessControl {
  private readonly grants = new Map<string, Set<string>>()

  grant(session: string, names: readonly string[]): string[] {
    let set = this.grants.get(session)
    if (!set) this.grants.set(session, set = new Set())
    const added: string[] = []
    for (const name of names) {
      const n = normalizeApp(name)
      if (n && !set.has(n)) { set.add(n); added.push(n) }
    }
    return added
  }

  granted(session: string): string[] {
    return [...this.grants.get(session) ?? []]
  }

  isGranted(session: string, win: WindowLike): boolean {
    return this.granted(session).some(name => appMatches(name, win))
  }

  /** Names from `names` the session has not been granted yet (aliases count). */
  missing(session: string, names: readonly string[]): string[] {
    const set = this.grants.get(session) ?? new Set<string>()
    return names.filter(name => !set.has(normalizeApp(name)) && ![...set].some(granted => sameApp(granted, name)))
  }

  forget(session: string): void {
    this.grants.delete(session)
  }

  /**
   * Why input may not go to `win`, or undefined when it may. `action` is a
   * short verb for the message ("click", "type into").
   */
  denial(session: string, win: WindowLike | undefined, mode: AccessMode, blocked: readonly string[], action: string): string | undefined {
    if (!win || win.exe === '') return undefined // desktop background, secure desktop or an elevated window we cannot inspect
    const label = `${win.exe}${win.title ? ` ("${win.title.slice(0, 60)}")` : ''}`
    if (isHostWindow(win)) {
      return `Refused to ${action} ${label}: that is the DeepSeek Harness window you are chatting through. Bring the target app to the front first (open_application or windows focus), or minimize DeepSeek Harness.`
    }
    if ([...DEFAULT_BLOCKED, ...blocked].some(name => appMatches(name, win))) {
      return `Refused to ${action} ${label}: this app is blocked for computer use in the plugin settings. Ask the user to do this step themselves.`
    }
    if (mode === 'allow-all' || this.isGranted(session, win)) return undefined
    return `Refused to ${action} ${label}: the app is not granted for this session. Call request_access with this app's name first (granted so far: ${this.granted(session).join(', ') || 'none'}).`
  }
}
