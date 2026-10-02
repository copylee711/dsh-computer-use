/**
 * Plugin settings shared by the host and the settings page: defaults and the
 * tolerant reader for the Loader entry config. No schemastery here so the
 * browser bundle stays small.
 */
import type { Settings } from './computer.js'

/** The Loader entry id (settings namespace); see cordis.patch.yml. */
export const ENTRY_ID = 'copylee-computer-use'

export const DEFAULTS: Settings = {
  accessMode: 'per-app',
  overlay: true,
  overlayLabel: 'DeepSeek Harness',
  hostWindow: 'card',
  autoScreenshot: true,
  settleMs: 400,
  maxLongEdge: 1366,
  maxPixels: 1_150_000,
  jpegQuality: 80,
  blockedApps: [],
  pauseOnUserInput: true,
  userIdleMs: 1500,
}

/** Unwrap `.volatile()` refs (`{ get() }`) and fall back to defaults for bad values. */
export function resolveConfig(raw: unknown): Settings {
  const out: Record<string, unknown> = {}
  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      out[key] = value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get: () => unknown }).get()
        : value
    }
  }
  const num = (key: 'settleMs' | 'maxLongEdge' | 'maxPixels' | 'jpegQuality' | 'userIdleMs', min: number, max: number): number => {
    const value = out[key]
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : DEFAULTS[key]
  }
  const bool = (key: 'overlay' | 'autoScreenshot' | 'pauseOnUserInput'): boolean => typeof out[key] === 'boolean' ? out[key] : DEFAULTS[key]
  return {
    accessMode: out.accessMode === 'allow-all' || out.accessMode === 'per-app' ? out.accessMode : DEFAULTS.accessMode,
    overlay: bool('overlay'),
    overlayLabel: typeof out.overlayLabel === 'string' && out.overlayLabel.trim() !== '' ? out.overlayLabel.trim().slice(0, 40) : DEFAULTS.overlayLabel,
    hostWindow: out.hostWindow === 'card' || out.hostWindow === 'minimize' || out.hostWindow === 'keep'
      ? out.hostWindow
      : out.minimizeHostWindow === true ? 'minimize' : DEFAULTS.hostWindow,
    autoScreenshot: bool('autoScreenshot'),
    settleMs: num('settleMs', 0, 5000),
    maxLongEdge: num('maxLongEdge', 640, 3840),
    maxPixels: num('maxPixels', 300_000, 8_000_000),
    jpegQuality: num('jpegQuality', 30, 100),
    pauseOnUserInput: bool('pauseOnUserInput'),
    userIdleMs: num('userIdleMs', 300, 10_000),
    blockedApps: Array.isArray(out.blockedApps) ? out.blockedApps.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [],
  }
}
