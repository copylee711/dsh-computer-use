/**
 * Finding a control by what it says instead of where it is. A batch can then
 * act on things that were not on screen in the model's last screenshot (the
 * item of a menu it is about to open, the button of a dialog about to appear),
 * which is what lets one call cover a whole sequence.
 */

/** One UI Automation element as the helper reports it (physical pixels). */
export interface UiElement {
  role: string
  name: string
  value?: string
  checked?: boolean
  disabled?: boolean
  x: number
  y: number
  width: number
  height: number
}

export interface TargetQuery {
  /** UI Automation control type, when the target named one ("按钮:保存"). */
  role?: string
  name: string
}

export type TargetMatch =
  | { kind: 'found'; element: UiElement }
  | { kind: 'ambiguous'; candidates: UiElement[] }
  | { kind: 'missing'; suggestions: string[] }

/** Words a model may put before the colon, and the control types they stand for. */
const ROLES: Record<string, string[]> = {
  button: ['Button', 'SplitButton'], 按钮: ['Button', 'SplitButton'],
  menu: ['MenuItem', 'Menu'], menuitem: ['MenuItem'], 菜单: ['MenuItem', 'Menu'], 菜单项: ['MenuItem'],
  edit: ['Edit', 'Document'], input: ['Edit', 'Document'], textbox: ['Edit', 'Document'], 输入框: ['Edit', 'Document'], 文本框: ['Edit', 'Document'],
  tab: ['TabItem'], 标签: ['TabItem'], 标签页: ['TabItem'], 选项卡: ['TabItem'],
  link: ['Hyperlink'], 链接: ['Hyperlink'],
  checkbox: ['CheckBox'], 复选框: ['CheckBox'],
  radio: ['RadioButton'], 单选: ['RadioButton'], 单选框: ['RadioButton'],
  combo: ['ComboBox'], combobox: ['ComboBox'], 下拉框: ['ComboBox'],
  item: ['ListItem', 'TreeItem', 'DataItem'], listitem: ['ListItem'], 列表项: ['ListItem', 'DataItem'], treeitem: ['TreeItem'],
  text: ['Text'], 文本: ['Text'], 文字: ['Text'],
}

/** "按钮:保存" → Button named 保存; a colon that is not after a known role stays part of the name. */
export function parseTarget(target: string): TargetQuery & { roles?: string[] } {
  const text = target.trim()
  const colon = text.search(/[:：]/)
  if (colon > 0) {
    const roles = ROLES[text.slice(0, colon).trim().toLowerCase().replace(/[\s_-]/g, '')]
    const name = text.slice(colon + 1).trim()
    if (roles && name !== '') return { role: roles[0]!, roles, name }
  }
  return { name: text }
}

/**
 * Names as people read them: without the accelerator ("保存(S)", "&File"),
 * the trailing ellipsis of commands that open a dialog, and case.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/\s*[(（]&?[A-Za-z0-9][)）]/g, '')
    .replace(/&(?=\S)/g, '')
    .replace(/(\.{3}|…)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const center = (el: UiElement): string => `${Math.round(el.x + el.width / 2)},${Math.round(el.y + el.height / 2)}`

/**
 * Pick the element a target means. An exact name beats a name that starts with
 * the text, which beats one that merely contains it; within the best tier,
 * enabled controls beat disabled ones and real controls beat static text.
 * Several different places left after that is an ambiguity, not a guess.
 */
export function matchTarget(elements: readonly UiElement[], target: string): TargetMatch {
  const query = parseTarget(target)
  const wanted = normalizeName(query.name)
  if (wanted === '') return { kind: 'missing', suggestions: [] }
  const pool = query.roles ? elements.filter(el => query.roles!.includes(el.role)) : elements
  const tiers: UiElement[][] = [[], [], []]
  for (const el of pool) {
    const name = normalizeName(el.name)
    if (name === '') continue
    if (name === wanted) tiers[0]!.push(el)
    else if (name.startsWith(wanted)) tiers[1]!.push(el)
    else if (name.includes(wanted)) tiers[2]!.push(el)
  }
  let best = tiers.find(tier => tier.length > 0)
  if (!best) return { kind: 'missing', suggestions: suggest(elements, wanted) }
  const enabled = best.filter(el => !el.disabled)
  if (enabled.length > 0) best = enabled
  const controls = best.filter(el => el.role !== 'Text')
  if (controls.length > 0) best = controls
  // The same control is often reported twice (a button and the text inside it).
  const places = new Map<string, UiElement>()
  for (const el of best) if (!places.has(center(el))) places.set(center(el), el)
  const unique = [...places.values()].filter((el, _index, all) => !all.some(other => other !== el && contains(other, el)))
  if (unique.length === 1) return { kind: 'found', element: unique[0]! }
  return { kind: 'ambiguous', candidates: unique.slice(0, 8) }
}

/** `outer` strictly encloses `inner`: keep the inner, more specific one. */
function contains(inner: UiElement, outer: UiElement): boolean {
  return outer !== inner
    && outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height
    && (outer.width > inner.width || outer.height > inner.height)
}

/** Names worth offering when nothing matched: those sharing characters first, then whatever is there. */
function suggest(elements: readonly UiElement[], wanted: string): string[] {
  const names = [...new Set(elements.filter(el => el.role !== 'Text' && el.name.trim() !== '').map(el => el.name.trim()))]
  const chars = new Set(wanted)
  const score = (name: string): number => [...new Set(normalizeName(name))].filter(char => chars.has(char)).length
  return names.sort((a, b) => score(b) - score(a)).slice(0, 12)
}
