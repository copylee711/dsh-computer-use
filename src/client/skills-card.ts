/**
 * "应用技能" card: the per-app notes the agent keeps (see ../skills.ts). The
 * user can read, edit, add and delete them here; built-in skills can be
 * overridden and restored.
 */
import * as React from 'react'

const SKILLS_ROUTE = '/api/dsh-computer-use/skills'
const MAX_CHARS = 4000
const h = React.createElement

interface Skill { id: string; app: string; match: string[]; summary: string; content: string; source: 'builtin' | 'user'; overrides: boolean; updatedAt: number }
interface SkillsBody { ok: boolean; error?: string; dir?: string; skills?: Skill[] }
interface Draft { id: string; app: string; match: string; summary: string; content: string; isNew: boolean }

export function SkillsCard({ S }: { S: Record<string, React.CSSProperties> }): React.ReactElement {
  const [skills, setSkills] = React.useState<Skill[] | null>(null)
  const [dir, setDir] = React.useState('')
  const [draft, setDraft] = React.useState<Draft | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [note, setNote] = React.useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const call = React.useCallback(async (body?: Record<string, unknown>): Promise<boolean> => {
    setBusy(true)
    try {
      const response = await fetch(SKILLS_ROUTE, body
        ? { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { credentials: 'same-origin' })
      const result = await response.json() as SkillsBody
      if (!result.ok) throw new Error(result.error ?? '请求失败')
      setSkills(result.skills ?? [])
      setDir(result.dir ?? '')
      return true
    } catch (error) {
      setNote({ kind: 'error', text: (error as Error).message })
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  React.useEffect(() => { void call() }, [call])

  const edit = (skill: Skill): void => {
    setNote(null)
    setDraft({ id: skill.id, app: skill.app, match: skill.match.join(', '), summary: skill.summary, content: skill.content, isNew: false })
  }
  const save = async (): Promise<void> => {
    if (!draft) return
    setNote(null)
    const ok = await call({ op: 'save', id: draft.isNew ? '' : draft.id, app: draft.app, match: draft.match, summary: draft.summary, content: draft.content })
    if (ok) { setDraft(null); setNote({ kind: 'ok', text: '已保存' }) }
  }
  const remove = async (skill: Skill): Promise<void> => {
    setNote(null)
    if (await call({ op: 'delete', id: skill.id })) { if (draft?.id === skill.id) setDraft(null); setNote({ kind: 'ok', text: `已删除“${skill.app}”` }) }
  }
  const reset = async (skill: Skill): Promise<void> => {
    setNote(null)
    if (await call({ op: 'reset', id: skill.id })) { if (draft?.id === skill.id) setDraft(null); setNote({ kind: 'ok', text: `已恢复“${skill.app}”的内置版本` }) }
  }

  const row: React.CSSProperties = { display: 'flex', gap: 10, alignItems: 'center', padding: '8px 0', borderTop: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.18))' }
  const small: React.CSSProperties = { ...S.secondary, padding: '4px 10px', fontSize: 12 }
  const tag: React.CSSProperties = { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))', color: 'var(--dsw-alias-label-tertiary, #888)', whiteSpace: 'nowrap' }
  const invalid = draft !== null && (draft.app.trim() === '' || draft.content.trim() === '' || draft.content.length > MAX_CHARS)

  return h('section', { style: S.card },
    h('h3', { style: S.cardTitle }, '应用技能'),
    h('p', { style: S.hint }, 'AI 对各个应用的操作笔记：每个应用一份，AI 摸索清楚一个不熟悉的应用后会自己记下来，以后打开这个应用时自动读取，不占用系统提示。你可以在这里查看、修改、删除或新建。'),
    skills === null ? h('p', { style: S.hint }, busy ? '正在读取…' : '无法读取应用技能。')
      : skills.length === 0 ? h('p', { style: S.hint }, '还没有应用技能。')
        : h('div', null, ...skills.map(skill => h('div', { key: skill.id, style: row },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontSize: 13, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' } },
              skill.app,
              h('span', { style: tag }, skill.source === 'builtin' ? '内置' : skill.overrides ? '已修改' : 'AI / 自定义'),
            ),
            h('div', { style: { ...S.hint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `${skill.summary || '（无摘要）'} · ${skill.content.length} 字`),
          ),
          h('button', { type: 'button', style: small, disabled: busy, onClick: () => edit(skill) }, '查看 / 编辑'),
          skill.overrides ? h('button', { type: 'button', style: small, disabled: busy, onClick: () => { void reset(skill) } }, '恢复内置') : null,
          h('button', { type: 'button', style: small, disabled: busy, onClick: () => { void remove(skill) } }, '删除'),
        ))),
    draft === null ? null : h('div', { style: { display: 'grid', gap: 10, paddingTop: 4 } },
      h('div', { style: S.grid2 },
        h('label', { style: S.label }, '应用名称',
          h('input', { style: S.input, value: draft.app, disabled: !draft.isNew, maxLength: 60, placeholder: '如 Obsidian', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, app: e.target.value }) })),
        h('label', { style: S.label }, '匹配的程序（逗号分隔）',
          h('input', { style: S.input, value: draft.match, maxLength: 200, placeholder: '如 Obsidian, obsidian.exe', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, match: e.target.value }) })),
      ),
      h('label', { style: S.label }, '摘要',
        h('input', { style: S.input, value: draft.summary, maxLength: 80, placeholder: '几个词说明这份技能讲什么', onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, summary: e.target.value }) })),
      h('label', { style: S.label }, `内容（${draft.content.length} / ${MAX_CHARS} 字）`,
        h('textarea', {
          style: { ...S.input, minHeight: 200, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.55 }, value: draft.content,
          placeholder: '- 一条一条写操作规律：入口在哪、快捷键、容易踩的坑',
          onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, content: e.target.value }),
        })),
      h('div', { style: S.actions },
        h('button', { type: 'button', style: { ...S.primary, opacity: busy || invalid ? 0.5 : 1 }, disabled: busy || invalid, onClick: () => { void save() } }, '保存技能'),
        h('button', { type: 'button', style: S.secondary, disabled: busy, onClick: () => setDraft(null) }, '取消'),
        draft.content.length > MAX_CHARS ? h('span', { style: S.error }, '内容过长，请精简') : null,
      ),
    ),
    h('div', { style: S.actions },
      draft === null ? h('button', { type: 'button', style: S.secondary, disabled: busy, onClick: () => { setNote(null); setDraft({ id: '', app: '', match: '', summary: '', content: '', isNew: true }) } }, '新建技能') : null,
      h('button', { type: 'button', style: S.secondary, disabled: busy, onClick: () => { void call() } }, '刷新'),
      note === null ? null : h('span', { style: note.kind === 'ok' ? S.ok : S.error }, note.text),
    ),
    dir ? h('p', { style: S.hint }, `保存位置：${dir}（每个应用一个 .md 文件，也可以直接用编辑器改）。删除内置技能后，新建同名技能即可重新启用。`) : null,
  )
}
