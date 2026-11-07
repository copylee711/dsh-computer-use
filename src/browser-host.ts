import type { HelperLike } from './helper-client.js'
import type { Rect } from './coords.js'

interface BrowserWindow { hwnd: number; pid: number; exe: string }
export interface BrowserTab { url?: string; tab?: string; content?: Rect; contentFocused?: boolean }

export function isBrowser(win: BrowserWindow): boolean {
  return /^(?:chrome|msedge|firefox|brave|vivaldi|chromium)\.exe$/i.test(win.exe)
}

export function httpOrigin(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch { /* Invalid URL. */ }
}

export function isHarnessAddress(address: string | undefined, harnessUrl: string): boolean {
  const expected = httpOrigin(harnessUrl)
  if (!address || !expected) return false
  // Browsers sometimes omit the scheme from the address bar.
  const actual = httpOrigin(address.includes('://') ? address : new URL(expected).protocol + '//' + address)
  if (!actual) return false
  if (actual === expected) return true
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]'])
  const a = new URL(actual), b = new URL(expected)
  return loopback.has(a.hostname) && loopback.has(b.hostname) && a.protocol === b.protocol && a.port === b.port
}

export async function readBrowserTab(helper: HelperLike, win: BrowserWindow, details = false): Promise<BrowserTab | undefined> {
  const state = await helper.call<BrowserTab | null>('browser_tab', { hwnd: win.hwnd, pid: win.pid, ...(details ? { details } : {}) }, 2500).catch(() => null)
  return state ?? undefined
}

export function safeSharedBrowserKeys(combos: number[][]): boolean {
  return combos.every(combo => {
    const key = combo.at(-1)
    if (key === undefined) return false
    const modifiers = combo.slice(0, -1)
    if (modifiers.includes(0x11)) return modifiers.length === 1 && [0x41, 0x43, 0x56, 0x58, 0x59, 0x5A].includes(key)
    return modifiers.every(mod => mod === 0x10)
      && ([8, 9, 13, 27, 32, 33, 34, 35, 36, 37, 38, 39, 40, 46].includes(key) || (key >= 0x30 && key <= 0x5A))
  })
}
