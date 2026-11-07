import type { HelperLike } from './helper-client.js'

interface BrowserWindow { hwnd: number; pid: number; exe: string }
export interface BrowserTab { url?: string; tab?: string }

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

export async function readBrowserTab(helper: HelperLike, win: BrowserWindow): Promise<BrowserTab | undefined> {
  const state = await helper.call<BrowserTab | null>('browser_tab', { hwnd: win.hwnd, pid: win.pid }, 2500).catch(() => null)
  return state ?? undefined
}
