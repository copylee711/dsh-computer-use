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

interface Parsed { app: string; match: string[]; summary: string; content: string; disabled: boolean }

export function skillId(app: string): string {
  const id = app.trim().toLowerCase().replace(/\.exe$/, '').replace(/[\\/:*?"<>|\s.]+/g, '-').replace(/^-+|-+$/g, '')
  return id.slice(0, 60) || 'app'
}

export function parseSkill(text: string, fallbackApp: string): Parsed {
  const out: Parsed = { app: fallbackApp, match: [], summary: '', content: text.trim(), disabled: false }
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
  }
  return out
}

export function formatSkill(skill: { app: string; match: string[]; summary: string; content: string }, disabled = false): string {
  const head = [`app: ${skill.app}`, `match: ${skill.match.join(', ')}`, `summary: ${skill.summary.replace(/\r?\n/g, ' ')}`]
  if (disabled) head.push('disabled: true')
  return `---\n${head.join('\n')}\n---\n${skill.content.trim()}\n`
}

export class SkillStore {
  constructor(
    private readonly builtinDir: string,
    readonly userDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'computer-use-skills'),
  ) {}

  private load(dir: string, source: 'builtin' | 'user'): Map<string, Skill & { disabled: boolean }> {
    const map = new Map<string, Skill & { disabled: boolean }>()
    if (!existsSync(dir)) return map
    for (const name of readdirSync(dir)) {
      if (!name.toLowerCase().endsWith('.md')) continue
      try {
        const path = join(dir, name)
        const parsed = parseSkill(readFileSync(path, 'utf8'), name.slice(0, -3))
        const id = skillId(name.slice(0, -3))
        map.set(id, {
          id, app: parsed.app, match: parsed.match.length > 0 ? parsed.match : [parsed.app], summary: parsed.summary,
          content: parsed.content, source, overrides: false, updatedAt: statSync(path).mtimeMs, disabled: parsed.disabled,
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
      const { disabled: _disabled, ...rest } = skill
      out.push({ ...rest, overrides: builtin.has(id) })
    }
    for (const [id, skill] of builtin) {
      if (user.has(id)) continue
      const { disabled: _disabled, ...rest } = skill
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

  save(input: SkillInput, id = skillId(input.app)): Skill {
    const app = input.app.trim()
    if (app === '') throw new Error('app is required.')
    const content = input.content.trim()
    if (content === '') throw new Error('content is empty.')
    if (content.length > SKILL_MAX_CHARS) {
      throw new Error(`The skill would be ${content.length} characters; the limit is ${SKILL_MAX_CHARS}. Condense it (merge duplicates, drop one-off details) and write it again.`)
    }
    const previous = this.get(id)
    const match = [...new Set([...(input.match ?? []), ...(previous?.match ?? []), app].map(item => item.trim()).filter(item => item !== '' && !GENERIC_HOSTS.test(item)))]
    const summary = (input.summary ?? previous?.summary ?? '').trim().slice(0, 80)
    mkdirSync(this.userDir, { recursive: true })
    const path = join(this.userDir, `${skillId(id)}.md`)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, formatSkill({ app, match, summary, content }), 'utf8')
    renameSync(tmp, path)
    return this.get(id)!
  }

  append(app: string, text: string, extra: { match?: string[]; summary?: string } = {}): Skill {
    const previous = this.find(app)
    const content = previous ? `${previous.content}\n${text.trim()}` : text.trim()
    return this.save({ app: previous?.app ?? app, content, ...extra }, previous?.id ?? skillId(app))
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
