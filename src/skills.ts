/**
 * App skills: short notes on how to operate one application, kept by the agent
 * (and editable by the user) as one Markdown file per app. Only a one-line
 * catalog goes into the system prompt; the notes themselves are handed over
 * when the app is opened, or read on demand.
 *
 * File format (front matter is optional):
 *   ---
 *   app: Obsidian
 *   match: obsidian.exe, obsidian
 *   summary: 打字规律、新建笔记
 *   ---
 *   - notes...
 *
 * The plugin ships a few built-in skills; a user file with the same id
 * overrides one, and `disabled: true` hides it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { appMatches, type WindowLike } from './access.js'

/** Notes longer than this must be condensed before more is added. */
export const SKILL_MAX_CHARS = 4000

/** Host processes shared by many apps: never a way to recognise one app. */
const GENERIC_HOSTS = /^(applicationframehost|explorer|msedgewebview2|javaw?|python\w*|electron)(\.exe)?$/i

export interface Skill {
  id: string
  app: string
  /** Names / exe names this skill applies to. */
  match: string[]
  summary: string
  content: string
  source: 'builtin' | 'user'
  /** A user file replaces a built-in skill of the same id. */
  overrides: boolean
  updatedAt: number
}

export interface SkillInput {
  app: string
  match?: string[]
  summary?: string
  content: string
}

interface Parsed { app: string; match: string[]; summary: string; content: string; disabled: boolean; extend: boolean }

export function skillId(app: string): string {
  const id = app.trim().toLowerCase().replace(/\.exe$/, '').replace(/[\\/:*?"<>|\s.]+/g, '-').replace(/^-+|-+$/g, '')
  return id.slice(0, 60) || 'app'
}

export function parseSkill(text: string, fallbackApp: string): Parsed {
  const out: Parsed = { app: fallbackApp, match: [], summary: '', content: text.trim(), disabled: false, extend: false }
  const front = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!front) return out
  out.content = text.slice(front[0].length).trim()
  for (const line of front[1]!.split(/\r?\n/)) {
    const pair = /^([a-z]+)\s*:\s*(.*)$/i.exec(line.trim())
    if (!pair) continue
    const key = pair[1]!.toLowerCase()
    const value = pair[2]!.trim()
    if (key === 'app' && value) out.app = value
    else if (key === 'match') out.match = value.split(/[,，]/).map(item => item.trim()).filter(Boolean)
    else if (key === 'summary') out.summary = value
    else if (key === 'disabled') out.disabled = value === 'true'
    else if (key === 'extends') out.extend = value === 'builtin'
  }
  return out
}

export function formatSkill(skill: { app: string; match: string[]; summary: string; content: string }, disabled = false, extend = false): string {
  const head = [`app: ${skill.app}`, `match: ${skill.match.join(', ')}`, `summary: ${skill.summary.replace(/\r?\n/g, ' ')}`]
  if (disabled) head.push('disabled: true')
  // The notes are additions to the built-in skill of the same id, which keeps receiving updates.
  if (extend) head.push('extends: builtin')
  return `---\n${head.join('\n')}\n---\n${skill.content.trim()}\n`
}

export class SkillStore {
  constructor(
    private readonly builtinDir: string,
    readonly userDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'computer-use-skills'),
  ) {}

  private load(dir: string, source: 'builtin' | 'user'): Map<string, Skill & { disabled: boolean; extend: boolean }> {
    const map = new Map<string, Skill & { disabled: boolean; extend: boolean }>()
    if (!existsSync(dir)) return map
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue
      try {
        const path = join(dir, name)
        const parsed = parseSkill(readFileSync(path, 'utf8'), name.slice(0, -3))
        const id = skillId(name.slice(0, -3))
        map.set(id, {
          id, app: parsed.app, match: parsed.match.length > 0 ? parsed.match : [parsed.app], summary: parsed.summary,
          content: parsed.content, source, overrides: false, updatedAt: statSync(path).mtimeMs, disabled: parsed.disabled, extend: parsed.extend,
        })
      } catch { /* unreadable file: skip */ }
    }
    return map
  }

  /** Every active skill, user files first in precedence, sorted by app name. */
  list(): Skill[] {
    const builtin = this.load(this.builtinDir, 'builtin')
    const user = this.load(this.userDir, 'user')
    const out: Skill[] = []
    for (const [id, skill] of user) {
      if (skill.disabled) continue
      const { disabled: _disabled, extend, ...rest } = skill
      const base = extend ? builtin.get(id) : undefined
      // "extends: builtin": the built-in skill plus the notes added on top of it.
      if (base) out.push({ ...rest, app: base.app, match: [...new Set([...base.match, ...rest.match])], summary: rest.summary || base.summary, content: `${base.content}\n${rest.content}`.trim(), overrides: true })
      else out.push({ ...rest, overrides: builtin.has(id) })
    }
    for (const [id, skill] of builtin) {
      if (user.has(id)) continue
      const { disabled: _disabled, extend: _extend, ...rest } = skill
      out.push(rest)
    }
    return out.sort((a, b) => a.app.localeCompare(b.app, 'zh-CN'))
  }

  get(id: string): Skill | undefined {
    const wanted = skillId(id)
    return this.list().find(skill => skill.id === wanted)
  }

  /** The skill for an app by name, or for a window by its executable. */
  find(name: string, win?: WindowLike): Skill | undefined {
    const skills = this.list()
    const wanted = skillId(name)
    return skills.find(skill => skill.id === wanted)
      ?? skills.find(skill => skill.match.some(item => skillId(item) === wanted))
      ?? (win ? skills.find(skill => skill.match.some(item => !GENERIC_HOSTS.test(item) && appMatches(item, win))) : undefined)
  }

  /** One line per skill for the system prompt. */
  catalog(): string {
    return this.list().map(skill => `${skill.app}${skill.summary ? ` (${skill.summary})` : ''}`).join('; ')
  }

  save(input: SkillInput, id = skillId(input.app), extend = false): Skill {
    const app = input.app.trim()
    if (app === '') throw new Error('app is required.')
    const content = input.content.trim()
    if (content === '') throw new Error('content is empty.')
    const total = content.length + (extend ? (this.load(this.builtinDir, 'builtin').get(skillId(id))?.content.length ?? 0) + 1 : 0)
    if (total > SKILL_MAX_CHARS) {
      throw new Error(`The skill would be ${total} characters; the limit is ${SKILL_MAX_CHARS}. Condense it (merge duplicates, drop one-off details) and write it again.`)
    }
    const previous = this.get(id)
    const match = [...new Set([...(input.match ?? []), ...(previous?.match ?? []), app].map(item => item.trim()).filter(item => item !== '' && !GENERIC_HOSTS.test(item)))]
    const summary = (input.summary ?? previous?.summary ?? '').trim().slice(0, 80)
    mkdirSync(this.userDir, { recursive: true })
    const path = join(this.userDir, `${skillId(id)}.md`)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, formatSkill({ app, match, summary, content }, false, extend), 'utf8')
    renameSync(tmp, path)
    return this.get(id)!
  }

  append(app: string, text: string, extra: { match?: string[]; summary?: string } = {}): Skill {
    const previous = this.find(app)
    if (!previous) return this.save({ app, content: text.trim(), ...extra })
    // Notes on top of a built-in skill are kept apart from it, so the built-in part stays up to date.
    const own = this.load(this.userDir, 'user').get(previous.id)
    const builtin = this.load(this.builtinDir, 'builtin').has(previous.id)
    if (builtin && (!own || own.extend)) {
      return this.save({ app: previous.app, content: own ? `${own.content}\n${text.trim()}` : text.trim(), ...extra }, previous.id, true)
    }
    return this.save({ app: previous.app, content: `${previous.content}\n${text.trim()}`, ...extra }, previous.id)
  }

  /** Delete a user skill; a built-in one is hidden by a disabled override. */
  remove(id: string): void {
    const wanted = skillId(id)
    const path = join(this.userDir, `${wanted}.md`)
    const builtin = this.load(this.builtinDir, 'builtin').get(wanted)
    if (builtin) {
      mkdirSync(this.userDir, { recursive: true })
      writeFileSync(path, formatSkill({ app: builtin.app, match: builtin.match, summary: builtin.summary, content: '' }, true), 'utf8')
    } else if (existsSync(path)) unlinkSync(path)
  }

  /** Drop the user's override so the built-in skill applies again. */
  reset(id: string): void {
    const path = join(this.userDir, `${skillId(id)}.md`)
    if (existsSync(path)) unlinkSync(path)
  }
}
