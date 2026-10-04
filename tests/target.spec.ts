import { describe, expect, it } from 'vitest'
import { matchTarget, normalizeName, parseTarget, type UiElement } from '../src/target.js'

const el = (role: string, name: string, x: number, y: number, extra: Partial<UiElement> = {}): UiElement => ({ role, name, x, y, width: 80, height: 30, ...extra })

describe('control targets', () => {
  it('reads names the way people do: no accelerator, no ellipsis, any case', () => {
    expect(normalizeName('保存(S)')).toBe('保存')
    expect(normalizeName('&File')).toBe('file')
    expect(normalizeName('另存为(A)...')).toBe('另存为')
    expect(normalizeName('Save As…')).toBe('save as')
  })

  it('takes a role before the colon only when it is one', () => {
    expect(parseTarget('按钮:保存')).toMatchObject({ role: 'Button', name: '保存' })
    expect(parseTarget('Menu Item：另存为')).toMatchObject({ role: 'MenuItem', name: '另存为' })
    expect(parseTarget('时间: 12:30')).toEqual({ name: '时间: 12:30' })
  })

  it('prefers an exact name over one that only starts with or contains the text', () => {
    const elements = [el('MenuItem', '另存为(A)...', 0, 0), el('MenuItem', '保存(S)', 0, 40), el('Button', '不保存', 0, 80)]
    const match = matchTarget(elements, '保存')
    expect(match).toMatchObject({ kind: 'found', element: { name: '保存(S)' } })
  })

  it('prefers enabled controls, and controls over the text inside them', () => {
    const elements = [el('Button', '确定', 0, 0, { disabled: true }), el('Button', '确定', 200, 0), el('Text', '确定', 400, 0)]
    expect(matchTarget(elements, '确定')).toMatchObject({ kind: 'found', element: { x: 200 } })
  })

  it('treats a control and the label inside it as one place', () => {
    const elements = [el('Button', '保存', 100, 100, { width: 80, height: 30 }), el('Text', '保存', 104, 102, { width: 60, height: 20 }), el('Button', '保存', 106, 104, { width: 50, height: 18 })]
    expect(matchTarget(elements, '保存')).toMatchObject({ kind: 'found', element: { x: 106 } })
  })

  it('reports several different places as ambiguous instead of guessing', () => {
    const match = matchTarget([el('Button', '删除', 0, 0), el('Button', '删除', 300, 0)], '删除')
    expect(match.kind).toBe('ambiguous')
    expect(match.kind === 'ambiguous' && match.candidates).toHaveLength(2)
  })

  it('narrows by role', () => {
    const elements = [el('TabItem', '设置', 0, 0), el('Button', '设置', 300, 0)]
    expect(matchTarget(elements, '按钮:设置')).toMatchObject({ kind: 'found', element: { role: 'Button' } })
  })

  it('suggests what is there when nothing matches', () => {
    const match = matchTarget([el('Button', '保存', 0, 0), el('Button', '取消', 100, 0), el('Text', '说明文字', 200, 0)], '另存')
    expect(match.kind).toBe('missing')
    expect(match.kind === 'missing' && match.suggestions[0]).toBe('保存')
    expect(match.kind === 'missing' && match.suggestions).not.toContain('说明文字')
  })
})
