/**
 * Give the "电脑控制" row in the DSH settings navigation a mouse-pointer icon
 * instead of the shell's fallback gear.
 *
 * `settings.section` registrations only carry `id`, `order` and `label`; the
 * shell picks icons for built-in ids only. So, like dsh-better-sidebar, we mark
 * our own row by its label and let CSS swap the glyph (Lucide mouse-pointer-2,
 * drawn as a currentColor mask so hover / active colors still apply).
 */

const MARKER = 'data-dsh-computer-use-settings-nav'

const POINTER_SVG = "%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z'/%3E%3C/svg%3E"

export const navIconCss = `
[${MARKER}] > svg:first-child { display: none; }
[${MARKER}]::before {
  content: '';
  flex: none;
  width: 16px;
  height: 16px;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,${POINTER_SVG}") center / contain no-repeat;
  mask: url("data:image/svg+xml,${POINTER_SVG}") center / contain no-repeat;
}
`

/** Keep the marker on the settings-nav button labelled `label`; returns a disposer. */
export function registerNavIcon(label: string): () => void {
  const style = document.createElement('style')
  style.setAttribute('data-dsh-computer-use', 'nav-icon')
  style.textContent = navIconCss
  document.head.appendChild(style)
  let disposed = false
  const sync = (): void => {
    if (disposed) return
    for (const button of document.querySelectorAll('[role="dialog"] nav button')) {
      const mine = button.textContent?.trim() === label
      if (mine && !button.hasAttribute(MARKER)) button.setAttribute(MARKER, '')
      else if (!mine && button.hasAttribute(MARKER)) button.removeAttribute(MARKER)
    }
  }
  sync()
  const observer = new MutationObserver(sync)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return () => {
    disposed = true
    observer.disconnect()
    style.remove()
    document.querySelectorAll(`[${MARKER}]`).forEach(element => element.removeAttribute(MARKER))
  }
}
