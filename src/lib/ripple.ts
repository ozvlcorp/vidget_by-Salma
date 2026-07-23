// Material 3 ripple — app-wide, delegated. Adds an ink ripple to any clicked
// button/link (or [data-ripple]) without touching component markup.
export function installRipple(): void {
  if (typeof document === 'undefined') return
  document.addEventListener('pointerdown', (e) => {
    const pe = e as PointerEvent
    const target = (pe.target as HTMLElement | null)?.closest('button, a, [data-ripple]') as HTMLElement | null
    if (!target || target.hasAttribute('data-no-ripple') || target.hasAttribute('disabled')) return

    const rect = target.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const cs = getComputedStyle(target)
    if (cs.position === 'static') target.style.position = 'relative'
    target.style.overflow = 'hidden'

    const size = Math.max(rect.width, rect.height)
    const ink = document.createElement('span')
    ink.className = 'm3-ripple-ink'
    ink.style.width = ink.style.height = `${size}px`
    ink.style.left = `${pe.clientX - rect.left - size / 2}px`
    ink.style.top = `${pe.clientY - rect.top - size / 2}px`
    target.appendChild(ink)
    ink.addEventListener('animationend', () => ink.remove(), { once: true })
  }, { passive: true })
}
