import * as React from 'react'
const h = React.createElement

/** Menu appearance and fixed-position behavior follow dsh-free-search / dsh-proxy. */
export const selectCss = `
.dshcu-select{box-sizing:border-box;width:100%;height:36px;padding:0 12px;display:flex;align-items:center;gap:8px;text-align:left;border:1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3));border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3,transparent);color:inherit;font:inherit;font-size:13px;cursor:pointer}
.dshcu-select:hover{border-color:var(--dsw-alias-border-l3,#888)}
.dshcu-select:focus-visible,.dshcu-select[aria-expanded=true]{outline:2px solid var(--cl-accent,#D97757);outline-offset:2px}
.dshcu-select:disabled{opacity:.5;cursor:default}
.dshcu-menu{position:fixed;z-index:1100;box-sizing:border-box;padding:4px;overflow-y:auto;overscroll-behavior:contain;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#222);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 10px 32px rgba(0,0,0,.16),0 0 0 .5px rgba(0,0,0,.1))}
.dshcu-option{display:flex;align-items:center;gap:8px;min-height:34px;padding:6px 8px;box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);font-size:13px;line-height:20px;cursor:pointer;user-select:none}
.dshcu-option[data-active=true]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
`

export function Select<V extends string>({ options, value, disabled, label, onChange }: {
  options: { value: V; label: string }[]; value: V; disabled?: boolean; label: string; onChange(value: V): void
}) {
  const id = React.useId()
  const trigger = React.useRef<HTMLButtonElement>(null)
  const list = React.useRef<HTMLDivElement>(null)
  const [open, setOpen] = React.useState(false)
  const [active, setActive] = React.useState(0)
  const [pos, setPos] = React.useState<React.CSSProperties>({})
  const selected = options.findIndex(option => option.value === value)
  const place = React.useCallback(() => {
    const r = trigger.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 12
    const above = r.top - 12
    const up = below < Math.min(options.length * 34 + 8, 220) && above > below
    const width = Math.min(Math.max(r.width, 180), 440, window.innerWidth - 16)
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), width,
      maxHeight: Math.max(0, Math.min(360, (up ? above : below) - 4)),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) })
  }, [options.length])
  const close = (refocus = false) => { setOpen(false); if (refocus) trigger.current?.focus() }
  const choose = (index: number) => { if (!disabled && options[index]) onChange(options[index]!.value); close(true) }
  const show = () => { if (!disabled) { place(); setActive(Math.max(0, selected)); setOpen(true) } }
  React.useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  React.useEffect(() => {
    if (!open) return
    const pointer = (e: PointerEvent) => {
      if (!list.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setOpen(false)
    }
    const scroll = (e: Event) => { if (!list.current?.contains(e.target as Node)) place() }
    document.addEventListener('pointerdown', pointer, true)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', pointer, true)
      window.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])
  React.useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active, open])
  return h('div', { style: { minWidth: 0 } },
    h('button', {
      ref: trigger, type: 'button', className: 'dshcu-select', disabled, role: 'combobox',
      'aria-label': label, 'aria-haspopup': 'listbox', 'aria-expanded': open,
      'aria-controls': open ? `${id}-list` : undefined,
      'aria-activedescendant': open ? `${id}-${active}` : undefined,
      onBlur: () => close(), onClick: () => open ? close() : show(),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (disabled) return
        if (!open) {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); show() }
        } else if (e.key === 'Escape') { e.preventDefault(); close(true) }
        else if (e.key === 'Tab') close()
        else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault()
          setActive(i => e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
        } else if (['Enter', ' '].includes(e.key)) { e.preventDefault(); choose(active) }
      },
    }, h('span', { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, options[selected]?.label),
    h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, style: { transform: open ? 'rotate(180deg)' : undefined } },
      h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }))),
    open ? h('div', { ref: list, id: `${id}-list`, role: 'listbox', 'aria-label': label, className: 'dshcu-menu', style: pos },
      ...options.map((option, i) => h('div', {
        key: option.value, id: `${id}-${i}`, role: 'option', 'aria-selected': i === selected,
        'data-index': i, 'data-active': i === active, className: 'dshcu-option',
        onPointerMove: () => setActive(i), onPointerDown: (e: React.PointerEvent) => e.preventDefault(), onClick: () => choose(i),
      }, h('span', { style: { flex: 1 } }, option.label),
      h('span', { style: { width: 14 } }, i === selected ? h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', { d: 'M3.5 8.5 6.5 11.5 12.5 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' })) : null)))) : null)
}
