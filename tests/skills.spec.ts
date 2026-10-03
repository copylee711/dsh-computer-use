import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SKILL_MAX_CHARS, SkillStore, parseSkill, skillId } from '../src/skills.js'

function store() {
  const root = mkdtempSync(join(tmpdir(), 'cu-skills-'))
  const builtin = join(root, 'builtin')
  mkdirSync(builtin)
  writeFileSync(join(builtin, 'word.md'), '---\napp: Word\nmatch: Word, winword.exe\nsummary: 另存为\n---\n- F12 另存为\n')
  return { skills: new SkillStore(builtin, join(root, 'user')), root }
}

describe('app skills', () => {
  it('parses front matter and derives ids', () => {
    expect(parseSkill('---\napp: QQ\nmatch: QQ, QQ.exe\nsummary: 群文件\n---\n- a\n', 'x')).toEqual({ app: 'QQ', match: ['QQ', 'QQ.exe'], summary: '群文件', content: '- a', disabled: false })
    expect(parseSkill('- just notes', 'obsidian').app).toBe('obsidian')
    expect(skillId('WINWORD.EXE')).toBe('winword')
    expect(skillId('Visual Studio Code')).toBe('visual-studio-code')
  })

  it('finds a built-in skill by name and by window executable', () => {
    const { skills } = store()
    expect(skills.find('word')?.content).toBe('- F12 另存为')
    expect(skills.find('文档1', { exe: 'WINWORD.EXE', title: '文档1 - Word' })?.app).toBe('Word')
    expect(skills.find('Excel')).toBeUndefined()
    expect(skills.catalog()).toBe('Word (另存为)')
  })

  it('the agent appends to a new skill, then to the same one', () => {
    const { skills, root } = store()
    skills.append('Obsidian', '- ctrl+o 新建笔记', { match: ['Obsidian.exe'], summary: '新建笔记' })
    const saved = skills.append('obsidian', '- 列表自动续行')
    expect(saved.content).toBe('- ctrl+o 新建笔记\n- 列表自动续行')
    expect(saved.match).toEqual(expect.arrayContaining(['Obsidian.exe', 'Obsidian']))
    expect(saved.summary).toBe('新建笔记')
    expect(readFileSync(join(root, 'user', 'obsidian.md'), 'utf8')).toContain('app: Obsidian')
  })

  it('a user edit overrides a built-in skill; reset and delete work', () => {
    const { skills } = store()
    skills.save({ app: 'Word', content: '- 我的版本' })
    expect(skills.get('word')).toMatchObject({ source: 'user', overrides: true, content: '- 我的版本' })
    skills.reset('word')
    expect(skills.get('word')).toMatchObject({ source: 'builtin', content: '- F12 另存为' })
    skills.remove('word')
    expect(skills.get('word')).toBeUndefined()
    expect(skills.list()).toEqual([])
    skills.save({ app: 'Word', content: '- 重新启用' })
    expect(skills.get('word')?.content).toBe('- 重新启用')
  })

  it('refuses a skill over the size limit', () => {
    const { skills } = store()
    expect(() => skills.save({ app: 'Big', content: 'x'.repeat(SKILL_MAX_CHARS + 1) })).toThrow(/Condense/)
  })
})

describe('shared host processes', () => {
  it('never match a skill by ApplicationFrameHost.exe', () => {
    const { skills } = store()
    skills.save({ app: '计算器', match: ['ApplicationFrameHost.exe'], content: '- type 123*456' })
    expect(skills.get('计算器')?.match).toEqual(['计算器'])
    expect(skills.find('设置', { exe: 'ApplicationFrameHost.exe', title: '设置' })).toBeUndefined()
    expect(skills.find('x', { exe: 'ApplicationFrameHost.exe', title: '计算器' })?.app).toBe('计算器')
  })
})
