/**
 * xdotool-style key names (what the Anthropic computer tool and most models
 * emit: "ctrl+shift+t", "Return", "super", "F5") mapped to Windows virtual-key
 * codes. One combo is a list of VKs pressed in order and released in reverse.
 */

const NAMED: Record<string, number> = {
  // modifiers
  ctrl: 0x11, control: 0x11, lctrl: 0xa2, rctrl: 0xa3, control_l: 0xa2, control_r: 0xa3,
  shift: 0x10, lshift: 0xa0, rshift: 0xa1, shift_l: 0xa0, shift_r: 0xa1,
  alt: 0x12, menu: 0x12, lalt: 0xa4, ralt: 0xa5, alt_l: 0xa4, alt_r: 0xa5, option: 0x12, altgr: 0xa5,
  win: 0x5b, super: 0x5b, meta: 0x5b, cmd: 0x5b, command: 0x5b, windows: 0x5b, super_l: 0x5b, super_r: 0x5c, lwin: 0x5b, rwin: 0x5c,
  // editing / navigation
  return: 0x0d, enter: 0x0d, kp_enter: 0x0d, tab: 0x09, iso_left_tab: 0x09, space: 0x20, spacebar: 0x20,
  backspace: 0x08, back: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  escape: 0x1b, esc: 0x1b, home: 0x24, end: 0x23,
  pageup: 0x21, page_up: 0x21, prior: 0x21, pgup: 0x21, pagedown: 0x22, page_down: 0x22, next: 0x22, pgdn: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
  capslock: 0x14, caps_lock: 0x14, numlock: 0x90, num_lock: 0x90, scrolllock: 0x91, scroll_lock: 0x91,
  print: 0x2c, printscreen: 0x2c, print_screen: 0x2c, prtsc: 0x2c, pause: 0x13, break: 0x13,
  apps: 0x5d, contextmenu: 0x5d, context_menu: 0x5d,
  // media / browser
  volumeup: 0xaf, audioraisevolume: 0xaf, xf86audioraisevolume: 0xaf,
  volumedown: 0xae, audiolowervolume: 0xae, xf86audiolowervolume: 0xae,
  volumemute: 0xad, audiomute: 0xad, xf86audiomute: 0xad,
  medianext: 0xb0, audionext: 0xb0, xf86audionext: 0xb0,
  mediaprev: 0xb1, audioprev: 0xb1, xf86audioprev: 0xb1,
  mediaplaypause: 0xb3, audioplay: 0xb3, xf86audioplay: 0xb3, playpause: 0xb3,
  browserback: 0xa6, browserforward: 0xa7, browserrefresh: 0xa8,
  // numpad
  kp_0: 0x60, kp_1: 0x61, kp_2: 0x62, kp_3: 0x63, kp_4: 0x64, kp_5: 0x65, kp_6: 0x66, kp_7: 0x67, kp_8: 0x68, kp_9: 0x69,
  kp_multiply: 0x6a, kp_add: 0x6b, kp_subtract: 0x6d, kp_decimal: 0x6e, kp_divide: 0x6f,
  // punctuation by name (US layout OEM keys)
  minus: 0xbd, equal: 0xbb, equals: 0xbb, plus: 0xbb, comma: 0xbc, period: 0xbe, dot: 0xbe,
  slash: 0xbf, backslash: 0xdc, semicolon: 0xba, apostrophe: 0xde, quote: 0xde, grave: 0xc0, backquote: 0xc0, tilde: 0xc0,
  bracketleft: 0xdb, bracketright: 0xdd, leftbracket: 0xdb, rightbracket: 0xdd,
}

const PUNCT: Record<string, number> = {
  '-': 0xbd, '=': 0xbb, '+': 0xbb, ',': 0xbc, '.': 0xbe, '/': 0xbf, '\\': 0xdc,
  ';': 0xba, '\'': 0xde, '`': 0xc0, '[': 0xdb, ']': 0xdd,
}

/** One key name to a VK code, or undefined when unknown. */
export function keyCode(name: string): number | undefined {
  if (name.length === 1) {
    const ch = name.toUpperCase()
    if (/[A-Z0-9]/.test(ch)) return ch.charCodeAt(0)
    return PUNCT[name]
  }
  const lower = name.toLowerCase()
  const fn = /^f([1-9]|1\d|2[0-4])$/.exec(lower)
  if (fn) return 0x6f + Number(fn[1])
  return NAMED[lower] ?? NAMED[lower.replace(/[\s-]/g, '_')] ?? NAMED[lower.replace(/[\s_-]/g, '')]
}

/**
 * Parse "ctrl+shift+t" or a space-separated sequence "ctrl+a Delete" into
 * combos. A lone "+" is the plus key. Throws with the unknown name.
 */
export function parseKeys(text: string): number[][] {
  const combos: number[][] = []
  // Two-word key names ("Page Down", "Print Screen") would split into a key sequence.
  const joined = text.trim().replace(/\b(page|print|caps|num|scroll)\s+(up|down|screen|lock)\b/gi, '$1$2')
  for (const chord of joined.split(/\s+/).filter(Boolean)) {
    const parts = chord === '+' ? ['+'] : chord.split(/(?<!^)\+(?!$)/)
    const combo: number[] = []
    for (const part of parts) {
      const code = keyCode(part)
      if (code === undefined) throw new Error(`Unknown key "${part}" in "${chord}". Use names like ctrl, shift, alt, super, Return, Tab, Escape, Delete, Up, F5, a, 1.`)
      combo.push(code)
    }
    if (combo.length > 0) combos.push(combo)
  }
  if (combos.length === 0) throw new Error('No key given.')
  return combos
}

/** Modifier names accepted by the `modifiers` parameter of click/scroll actions. */
export function parseModifiers(text: string | undefined): number[] {
  if (text === undefined || text.trim() === '') return []
  return parseKeys(text.replace(/\s+/g, '')).flat()
}
