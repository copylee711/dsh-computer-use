import { describe, expect, it } from 'vitest'
import { AccessControl, appMatches } from '../src/access.js'

const chrome = { exe: 'chrome.exe', title: 'GitHub - Google Chrome' }
const host = { exe: 'DeepSeek Harness.exe', title: '打开 chrome — DeepSeek Harness' }
const notepad = { exe: 'Notepad.exe', title: '无标题 - 记事本' }
const calc = { exe: 'ApplicationFrameHost.exe', title: '计算器' }

describe('app matching', () => {
  it('matches exe names, product names and Chinese aliases', () => {
    expect(appMatches('Chrome', chrome)).toBe(true)
    expect(appMatches('Google Chrome', chrome)).toBe(true)
    expect(appMatches('chrome.exe', chrome)).toBe(true)
    expect(appMatches('记事本', notepad)).toBe(true)
    expect(appMatches('计算器', calc)).toBe(true)
    expect(appMatches('Edge', chrome)).toBe(false)
  })
  it('does not mistake the DSH window (Chromium-based) for Chrome', () => {
    expect(appMatches('Chrome', host)).toBe(false)
  })
})

describe('access control', () => {
  it('refuses ungranted apps in per-app mode and allows granted ones', () => {
    const access = new AccessControl()
    expect(access.denial('s1', chrome, 'per-app', [], 'click')).toMatch(/request_access/)
    access.grant('s1', ['Chrome'])
    expect(access.denial('s1', chrome, 'per-app', [], 'click')).toBeUndefined()
    expect(access.denial('s2', chrome, 'per-app', [], 'click')).toMatch(/not granted/)
  })
  it('never allows the DSH host window, even in allow-all mode', () => {
    const access = new AccessControl()
    access.grant('s1', ['DeepSeek Harness'])
    expect(access.denial('s1', host, 'allow-all', [], 'type into')).toMatch(/DeepSeek Harness window/)
  })
  it('blocks configured and built-in blocked apps', () => {
    const access = new AccessControl()
    expect(access.denial('s1', { exe: 'Bitwarden.exe', title: 'Vault' }, 'allow-all', [], 'click')).toMatch(/blocked/)
    expect(access.denial('s1', { exe: 'Alipay.exe', title: '支付宝' }, 'allow-all', ['alipay'], 'click')).toMatch(/blocked/)
  })
  it('lets the desktop background through', () => {
    expect(new AccessControl().denial('s1', undefined, 'per-app', [], 'click')).toBeUndefined()
  })
  it('reports which names are still missing', () => {
    const access = new AccessControl()
    access.grant('s1', ['Chrome.exe'])
    expect(access.missing('s1', ['chrome', '记事本'])).toEqual(['记事本'])
  })

  it('treats aliases of a granted app as granted', () => {
    const access = new AccessControl()
    access.grant('s1', ['explorer'])
    expect(access.missing('s1', ['文件资源管理器', '计算器'])).toEqual(['计算器'])
    access.grant('s1', ['计算器'])
    expect(access.missing('s1', ['设置'])).toEqual(['设置']) // UWP frame host alone does not link them
  })
})
