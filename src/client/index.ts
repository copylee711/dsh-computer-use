/**
 * Browser half: the "电脑控制" (Computer use) section in Settings. It reads the
 * plugin's own Loader entry through `remote.settings.describe()` and writes
 * with `remote.settings.mutate()`; every field is volatile, so a save reaches
 * the next action without a restart. Live status and the overlay preview come
 * from the host routes in ../routes.ts.
 */
import * as React from 'react'
import { DEFAULTS, ENTRY_ID, resolveConfig } from '../settings.js'
import type { Settings } from '../computer.js'
import { Select, selectCss } from './select.js'

const STATUS_ROUTE = '/api/dsh-computer-use/status'
const PREVIEW_ROUTE = '/api/dsh-computer-use/preview'

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message: string } }
interface NamespaceView { ns: string; value: unknown; revision: number }

interface ClientContext {
  effect(execute: () => (() => void) | void, label?: string): void
  slots: {
    inject(name: string, register: () => unknown): void
    register(meta: Record<string, unknown>, render: (props: unknown) => unknown): unknown
  }
  remote: {
    $on?(event: string, listener: (...args: unknown[]) => void): () => void
    settings: {
      describe(): Promise<RemoteResult<{ writable: boolean; namespaces: NamespaceView[] }>>
      mutate(ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[], expectedRevision?: number): Promise<RemoteResult<unknown>>
    }
  }
}

interface Status {
  helper: 'ready' | 'error'
  error?: string
  platform: string
  controlling: boolean
  displays: Array<{ width: number; height: number; dpi: number; primary: boolean; shot: { width: number; height: number } }>
}

/** Form state: numbers and lists as text so half-typed values do not jump. */
interface Draft {
  accessMode: Settings['accessMode']
  blockedApps: string
  overlay: boolean
  overlayLabel: string
  hostWindow: Settings['hostWindow']
  pauseOnUserInput: boolean
  userIdleMs: string
  autoScreenshot: boolean
  settleMs: string
  maxLongEdge: string
  maxMegapixels: string
  jpegQuality: string
}

const h = React.createElement

function draftFrom(value: unknown): Draft {
  const s = resolveConfig(value)
  return {
    accessMode: s.accessMode,
    blockedApps: s.blockedApps.join('\n'),
    overlay: s.overlay,
    overlayLabel: s.overlayLabel,
    hostWindow: s.hostWindow,
    pauseOnUserInput: s.pauseOnUserInput,
    userIdleMs: String(s.userIdleMs),
    autoScreenshot: s.autoScreenshot,
    settleMs: String(s.settleMs),
    maxLongEdge: String(s.maxLongEdge),
    maxMegapixels: String(Math.round(s.maxPixels / 10_000) / 100),
    jpegQuality: String(s.jpegQuality),
  }
}

/** Range-checked numbers; returns field errors keyed by Draft field. */
function validate(d: Draft): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {}
  const check = (key: keyof Draft, min: number, max: number) => {
    const n = Number(d[key])
    if (String(d[key]).trim() === '' || !Number.isFinite(n) || n < min || n > max) errors[key] = `${min} – ${max}`
  }
  check('userIdleMs', 300, 10_000)
  check('settleMs', 0, 5000)
  check('maxLongEdge', 640, 3840)
  check('maxMegapixels', 0.3, 8)
  check('jpegQuality', 30, 100)
  return errors
}

function valuesFrom(d: Draft): Record<string, unknown> {
  return {
    accessMode: d.accessMode,
    blockedApps: d.blockedApps.split(/[\n,，]/).map(item => item.trim()).filter(Boolean),
    overlay: d.overlay,
    overlayLabel: d.overlayLabel.trim() || DEFAULTS.overlayLabel,
    hostWindow: d.hostWindow,
    pauseOnUserInput: d.pauseOnUserInput,
    userIdleMs: Math.round(Number(d.userIdleMs)),
    autoScreenshot: d.autoScreenshot,
    settleMs: Math.round(Number(d.settleMs)),
    maxLongEdge: Math.round(Number(d.maxLongEdge)),
    maxPixels: Math.round(Number(d.maxMegapixels) * 1_000_000),
    jpegQuality: Math.round(Number(d.jpegQuality)),
  }
}

const S: Record<string, React.CSSProperties> = {
  page: { display: 'grid', gap: 20, maxWidth: 880, paddingBottom: 32, color: 'var(--dsw-alias-label-primary, inherit)' },
  title: { margin: 0, fontSize: 20, fontWeight: 600 },
  subtitle: { margin: '6px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary, #666)' },
  card: { display: 'grid', gap: 14, padding: 16, borderRadius: 'var(--dsw-radius-lg, 12px)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25))' },
  cardTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
  hint: { margin: 0, fontSize: 12, lineHeight: 1.55, color: 'var(--dsw-alias-label-tertiary, #888)' },
  label: { display: 'grid', gap: 6, fontSize: 13, fontWeight: 500 },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 },
  input: { boxSizing: 'border-box', width: '100%', padding: '8px 10px', fontSize: 13, borderRadius: 'var(--dsw-radius-md, 8px)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit' },
  toggleRow: { display: 'flex', gap: 12, alignItems: 'flex-start', justifyContent: 'space-between' },
  toggleText: { display: 'grid', gap: 4, fontSize: 13, fontWeight: 500 },
  error: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #d33)' },
  ok: { fontSize: 12, color: 'var(--dsw-alias-state-success-primary, #2a2)' },
  actions: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  primary: { padding: '7px 16px', fontSize: 13, borderRadius: 'var(--dsw-radius-md, 8px)', border: '1px solid #D97757', background: '#D97757', color: '#fff', cursor: 'pointer' },
  secondary: { padding: '7px 14px', fontSize: 13, borderRadius: 'var(--dsw-radius-md, 8px)', border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer' },
  statusLine: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 },
  dot: { width: 8, height: 8, borderRadius: 4, flex: '0 0 auto' },
}

function Switch({ checked, disabled, label, onChange }: { checked: boolean; disabled: boolean; label: string; onChange(value: boolean): void }) {
  return h('button', {
    type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label, disabled,
    onClick: () => onChange(!checked),
    style: {
      flex: '0 0 auto', width: 40, height: 22, borderRadius: 11, border: 'none', padding: 2, cursor: disabled ? 'default' : 'pointer',
      background: checked ? '#D97757' : 'var(--dsw-alias-border-l3, rgba(127,127,127,.35))', opacity: disabled ? 0.5 : 1, transition: 'background .15s',
    },
  }, h('span', { style: { display: 'block', width: 18, height: 18, borderRadius: 9, background: '#fff', transform: checked ? 'translateX(18px)' : 'none', transition: 'transform .15s' } }))
}

function ToggleRow({ title, hint, checked, disabled, onChange }: { title: string; hint: string; checked: boolean; disabled: boolean; onChange(value: boolean): void }) {
  return h('div', { style: S.toggleRow },
    h('div', { style: S.toggleText }, title, h('span', { style: { ...S.hint, fontWeight: 400 } }, hint)),
    h(Switch, { checked, disabled, label: title, onChange }),
  )
}

function NumberField({ label, unit, value, error, disabled, onChange }: { label: string; unit: string; value: string; error: string | undefined; disabled: boolean; onChange(value: string): void }) {
  return h('label', { style: S.label },
    label,
    h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
      h('input', { style: S.input, inputMode: 'decimal', value, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value) }),
      h('span', { style: { ...S.hint, whiteSpace: 'nowrap' } }, unit),
    ),
    error === undefined ? null : h('span', { style: S.error }, `范围 ${error}`),
  )
}

function ComputerUseSection({ ctx }: { ctx: ClientContext }) {
  const [loaded, setLoaded] = React.useState(false)
  const [writable, setWritable] = React.useState(false)
  const [view, setView] = React.useState<NamespaceView | undefined>(undefined)
  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(undefined))
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [status, setStatus] = React.useState<Status | null>(null)
  const dirtyRef = React.useRef(false)
  dirtyRef.current = dirty

  const load = React.useCallback(async (reset: boolean) => {
    try {
      const result = await ctx.remote.settings.describe()
      if (!result.ok) throw new Error(result.error.message)
      const found = result.value.namespaces.find(item => item.ns === ENTRY_ID)
      setWritable(result.value.writable)
      setView(found)
      if (reset || !dirtyRef.current) { setDraft(draftFrom(found?.value)); setDirty(false) }
    } catch (error) {
      setMessage({ kind: 'error', text: `读取设置失败：${(error as Error).message}` })
    } finally {
      setLoaded(true)
    }
  }, [ctx])

  const refreshStatus = React.useCallback(async () => {
    try {
      const response = await fetch(STATUS_ROUTE, { credentials: 'same-origin' })
      setStatus(await response.json() as Status)
    } catch {
      setStatus(null)
    }
  }, [])

  React.useEffect(() => {
    void load(true)
    void refreshStatus()
    return ctx.remote.$on?.('settings/document-updated', (ns: unknown) => { if (ns === ENTRY_ID) { void load(false); void refreshStatus() } }) ?? undefined
  }, [ctx, load, refreshStatus])

  const edit = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft(previous => ({ ...previous, [key]: value }))
    setDirty(true)
    setMessage(null)
  }

  const errors = validate(draft)
  const invalid = Object.keys(errors).length > 0
  const disabled = !writable || view === undefined || saving

  const save = async () => {
    if (view === undefined || invalid) return
    setSaving(true)
    try {
      const values = valuesFrom(draft)
      const result = await ctx.remote.settings.mutate(ENTRY_ID, Object.entries(values).map(([key, value]) => ({ op: 'set' as const, path: [key], value })), view.revision)
      if (!result.ok) throw new Error(result.error.message)
      setMessage({ kind: 'ok', text: '已保存，下一步操作即生效' })
      setDirty(false)
      await load(true)
      void refreshStatus()
    } catch (error) {
      setMessage({ kind: 'error', text: `保存失败：${(error as Error).message}` })
    } finally {
      setSaving(false)
    }
  }

  const preview = async () => {
    try {
      const response = await fetch(PREVIEW_ROUTE, { method: 'POST', credentials: 'same-origin' })
      if (response.status === 409) setMessage({ kind: 'error', text: 'AI 正在操控电脑，暂时不能预览' })
      else if (!response.ok) setMessage({ kind: 'error', text: '预览失败' })
    } catch {
      setMessage({ kind: 'error', text: '预览失败' })
    }
  }

  if (!loaded) return h('div', { style: S.page }, '加载中…')

  const primary = status?.displays.find(d => d.primary) ?? status?.displays[0]
  const helperOk = status?.helper === 'ready'

  return h('div', { style: S.page },
    h('style', null, selectCss),
    h('div', null,
      h('h2', { style: S.title }, '电脑控制'),
      h('p', { style: S.subtitle }, '让 AI 看屏幕、点鼠标、敲键盘操控这台 Windows 电脑。操控时屏幕四周泛起橙色光晕；按 Esc 暂停 / 继续，点提示条上的“停止”结束本轮。'),
    ),
    view === undefined ? h('div', { style: S.error }, '没有找到本插件的设置项（插件可能未启用）。') : null,
    view !== undefined && !writable ? h('div', { style: S.error }, '当前设置为只读。') : null,

    // Status
    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '运行状态'),
      h('div', { style: S.statusLine },
        h('span', { style: { ...S.dot, background: status === null ? '#999' : helperOk ? '#2a2' : '#d33' } }),
        status === null ? '无法获取状态' : helperOk ? (status.controlling ? '正在操控电脑' : '就绪') : `控制组件不可用：${status.error ?? ''}`,
      ),
      primary ? h('p', { style: S.hint }, `主屏幕 ${primary.width}×${primary.height}（${Math.round(primary.dpi / 96 * 100)}% 缩放），发给模型的截图为 ${primary.shot.width}×${primary.shot.height}。`) : null,
      status && status.displays.length > 1 ? h('p', { style: S.hint }, `共 ${status.displays.length} 块显示器，模型可用 switch_display 切换。`) : null,
      h('div', { style: S.actions },
        h('button', { type: 'button', style: S.secondary, onClick: () => { void preview() } }, '预览效果'),
        h('button', { type: 'button', style: S.secondary, onClick: () => { void refreshStatus() } }, '刷新状态'),
        h('span', { style: S.hint }, '预览会显示 3 秒光晕和提示条（按已保存的设置）。'),
      ),
    ),

    // Access
    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '授权'),
      h('div', { style: S.label },
        '授权方式',
        h(Select, {
          label: '授权方式', disabled, value: draft.accessMode,
          options: [{ value: 'per-app', label: '按应用授权（每个会话由你批准要操控的应用）' }, { value: 'allow-all', label: '全部允许（不弹审批）' }],
          onChange: (value: string) => edit('accessMode', value as Settings['accessMode']),
        }),
        h('span', { style: { ...S.hint, fontWeight: 400 } }, '会话权限为“完全权限”或“自动审查”时不弹审批，按应用授权会自动批准。无论哪种方式，DeepSeek Harness 自己的窗口都不会被操作。'),
      ),
      h('label', { style: S.label },
        '禁止操控的应用',
        h('textarea', {
          style: { ...S.input, minHeight: 72, resize: 'vertical' }, value: draft.blockedApps, disabled, spellCheck: false,
          placeholder: '每行一个，名称或 exe，例如：\nalipay\n网银助手',
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => edit('blockedApps', e.target.value),
        }),
        h('span', { style: { ...S.hint, fontWeight: 400 } }, '1Password、Bitwarden、KeePass 等常见密码管理器始终禁止。'),
      ),
    ),

    // Look
    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '操控时的显示'),
      h(ToggleRow, { title: '橙色光晕与提示条', hint: '不会出现在模型看到的截图里。', checked: draft.overlay, disabled, onChange: value => edit('overlay', value) }),
      h('div', { style: S.grid2 },
        h('label', { style: S.label },
          '提示条名称',
          h('input', { style: S.input, value: draft.overlayLabel, disabled, maxLength: 40, onChange: (e: React.ChangeEvent<HTMLInputElement>) => edit('overlayLabel', e.target.value) }),
          h('span', { style: { ...S.hint, fontWeight: 400 } }, `显示为“${draft.overlayLabel.trim() || DEFAULTS.overlayLabel} 正在操控你的电脑”`),
        ),
        h('div', { style: S.label },
          'DeepSeek Harness 窗口',
          h(Select, {
            label: 'DeepSeek Harness 窗口', disabled, value: draft.hostWindow,
            options: [{ value: 'card', label: '缩成右下角置顶悬浮卡片' }, { value: 'minimize', label: '最小化' }, { value: 'keep', label: '保持不变' }],
            onChange: (value: string) => edit('hostWindow', value as Settings['hostWindow']),
          }),
          h('span', { style: { ...S.hint, fontWeight: 400 } }, '操控结束后自动恢复原尺寸和位置。'),
        ),
      ),
    ),

    // Yield to the user
    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '让出控制'),
      h(ToggleRow, { title: '检测到你在操作时暂停', hint: '你用键盘打字时 AI 等你停手；你切换了窗口时 AI 先重新看屏幕。鼠标移动不会触发。', checked: draft.pauseOnUserInput, disabled, onChange: value => edit('pauseOnUserInput', value) }),
      h('div', { style: S.grid2 },
        h(NumberField, { label: '停手多久后继续', unit: '毫秒', value: draft.userIdleMs, error: errors.userIdleMs, disabled: disabled || !draft.pauseOnUserInput, onChange: value => edit('userIdleMs', value) }),
      ),
    ),

    // Screenshots
    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, '截图'),
      h(ToggleRow, { title: '操作后自动回传截图', hint: '省去模型再截一次图的一轮调用；关闭可省 token。', checked: draft.autoScreenshot, disabled, onChange: value => edit('autoScreenshot', value) }),
      h('div', { style: S.grid2 },
        h(NumberField, { label: '操作后等待界面稳定', unit: '毫秒', value: draft.settleMs, error: errors.settleMs, disabled, onChange: value => edit('settleMs', value) }),
        h(NumberField, { label: '截图最长边', unit: '像素', value: draft.maxLongEdge, error: errors.maxLongEdge, disabled, onChange: value => edit('maxLongEdge', value) }),
        h(NumberField, { label: '截图总像素上限', unit: '百万像素', value: draft.maxMegapixels, error: errors.maxMegapixels, disabled, onChange: value => edit('maxMegapixels', value) }),
        h(NumberField, { label: 'JPEG 质量', unit: '30–100', value: draft.jpegQuality, error: errors.jpegQuality, disabled, onChange: value => edit('jpegQuality', value) }),
      ),
      h('p', { style: S.hint }, '截图越大越清晰、点得越准，但每张图消耗的 token 也越多。默认值（最长边 1366、1.15 百万像素）适合大多数模型。'),
    ),

    h('div', { style: S.actions },
      h('button', {
        type: 'button', style: { ...S.primary, opacity: disabled || !dirty || invalid ? 0.5 : 1 },
        disabled: disabled || !dirty || invalid, onClick: () => { void save() },
      }, saving ? '保存中…' : '保存'),
      h('button', {
        type: 'button', style: S.secondary, disabled: !dirty || saving,
        onClick: () => { setDraft(draftFrom(view?.value)); setDirty(false); setMessage(null) },
      }, '放弃修改'),
      h('button', {
        type: 'button', style: S.secondary, disabled: disabled,
        onClick: () => { setDraft(draftFrom({})); setDirty(true); setMessage(null) },
      }, '恢复默认'),
      dirty ? h('span', { style: S.hint }, '有未保存的修改') : null,
      message === null ? null : h('span', { style: message.kind === 'ok' ? S.ok : S.error }, message.text),
    ),
  )
}

export const inject = ['slots', 'remote', 'remote.settings']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: ENTRY_ID,
    order: 61,
    label: () => '电脑控制',
  }, () => h(ComputerUseSection, { ctx })))
}
