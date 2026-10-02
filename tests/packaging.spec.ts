import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { helperSourcePath } from '../src/helper-client.js'
import { name } from '../src/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; files: string[]; publishConfig?: { access?: string } }

describe('packaging', () => {
  it('publishes publicly under the plugin name', () => {
    expect(pkg.name).toBe(name)
    expect(pkg.publishConfig?.access).toBe('public')
    expect(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')).toContain(pkg.name)
  })
  it('ships the helper source that the runtime compiles', () => {
    expect(pkg.files).toContain('helper/CuHelper.cs')
    expect(pkg.files).toContain('helper/deepseek-white.png')
    expect(existsSync(helperSourcePath())).toBe(true)
  })
  it('keeps the helper within C# 5 (in-box csc)', () => {
    const source = readFileSync(helperSourcePath(), 'utf8')
    expect(source).not.toMatch(/\$"/)
    expect(source).not.toMatch(/\?\.[A-Za-z]/)
  })
})
