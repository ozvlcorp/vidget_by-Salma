/* eslint-disable react-refresh/only-export-components -- shared grid helpers + cells live together */
import { useState, useRef, useEffect } from 'react'
import type { ChangeEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { NamedOption } from '../api/moysklad'

// Shared Excel-style grid building blocks used by both the payment and the
// customer-order sections, so the two look and behave identically.

export const CELL = 'w-full px-2.5 py-2 text-sm bg-transparent focus:outline-none text-fg placeholder-faint'
// Editable cell wrapper: right gridline + Excel "active cell" ring on focus.
export const CELLBOX = 'relative border-r border-line focus-within:z-10 focus-within:ring-2 focus-within:ring-accent focus-within:ring-inset'
// Row-number gutter cell.
export const GUTTER = 'flex items-center justify-center bg-surface-2 border-r border-line text-xs text-faint font-mono select-none'

export function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fmtMoney(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function HeadCell({
  label, className = '', onResizeStart,
}: {
  label: string
  className?: string
  /** When given, renders a drag grip on the cell's right edge to resize the column. */
  onResizeStart?: (e: ReactPointerEvent<HTMLDivElement>) => void
}) {
  return (
    <div className={`relative px-2.5 py-2.5 text-xs font-bold uppercase tracking-wide text-fg border-r border-line ${className}`}>
      {label}
      {onResizeStart && (
        <div
          onPointerDown={onResizeStart}
          onDoubleClick={e => e.stopPropagation()}
          title="Потяните, чтобы изменить ширину"
          className="absolute top-0 -right-1 z-30 h-full w-2 cursor-col-resize hover:bg-accent/50 active:bg-accent transition-colors"
        />
      )}
    </div>
  )
}

const MIN_COL_WIDTH = 56

/**
 * Resizable column widths for an Excel-style grid, persisted per grid in
 * localStorage. Returns the current widths plus a pointer-down handler that
 * drags column `i`'s right edge.
 */
export function useColumnWidths(storageKey: string, initial: number[]) {
  const [widths, setWidths] = useState<number[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const arr = JSON.parse(saved) as unknown
        if (Array.isArray(arr) && arr.length === initial.length && arr.every(n => typeof n === 'number')) {
          return arr as number[]
        }
      }
    } catch { /* ignore */ }
    return initial
  })
  const drag = useRef<{ index: number; startX: number; startW: number } | null>(null)

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(widths)) } catch { /* ignore */ }
  }, [storageKey, widths])

  useEffect(() => {
    function onMove(e: PointerEvent) {
      const d = drag.current
      if (!d) return
      const next = Math.max(MIN_COL_WIDTH, Math.round(d.startW + (e.clientX - d.startX)))
      setWidths(ws => ws.map((w, i) => (i === d.index ? next : w)))
    }
    function onUp() {
      if (!drag.current) return
      drag.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [])

  function startResize(index: number) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      drag.current = { index, startX: e.clientX, startW: widths[index] }
      // Keep the resize cursor while dragging anywhere on the page.
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }
  }

  return { widths, startResize, resetWidths: () => setWidths(initial) }
}

// ─── Searchable dropdown cell (portal so it never gets clipped by the table) ──
// Generic over the option type so callers can carry extra fields (e.g. a product's
// price) while still displaying { id, name }.
export function SearchCell<T extends NamedOption>({
  value, onSelect, fetch, token, placeholder, renderMeta, itemClassName, hideEmpty,
}: {
  value: T | null
  onSelect: (opt: T | null) => void
  fetch: (token: string, query: string) => Promise<T[]>
  token: string
  placeholder: string
  // Optional secondary text shown on the right of each option (e.g. stock balance).
  renderMeta?: (opt: T) => string | null
  // Optional extra classes per option (e.g. dim + red for out-of-stock products).
  itemClassName?: (opt: T) => string
  // When true, only show the menu if the query is non-empty AND has matches —
  // no "Загрузка…"/"Ничего не найдено" box, and no menu on an empty field.
  hideEmpty?: boolean
}) {
  const [query, setQuery] = useState(value?.name ?? '')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  function runSearch(q: string) {
    if (debounce.current) clearTimeout(debounce.current)
    setLoading(true)
    debounce.current = setTimeout(() => {
      fetch(token, q).then(setItems).finally(() => setLoading(false))
    }, 200)
  }

  function openMenu() {
    // In hideEmpty mode an empty field opens nothing.
    if (hideEmpty && !query.trim()) return
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect())
    setOpen(true)
    runSearch(query)
  }

  function handleInput(v: string) {
    setQuery(v)
    onSelect(null)
    if (hideEmpty && !v.trim()) { setItems([]); setOpen(false); return }
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect())
    setOpen(true)
    runSearch(v)
  }

  function choose(opt: T) {
    onSelect(opt)
    setQuery(opt.name)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (inputRef.current && !inputRef.current.contains(target) && !target.closest('[data-search-menu]')) {
        setOpen(false)
      }
    }
    function reposition() { if (inputRef.current) setRect(inputRef.current.getBoundingClientRect()) }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => handleInput(e.target.value)}
        onFocus={openMenu}
        placeholder={placeholder}
        className={CELL}
      />
      {open && rect && (!hideEmpty || items.length > 0) && createPortal(
        <div
          data-search-menu
          style={{ position: 'fixed', top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 200) }}
          className="z-[1000] max-h-60 overflow-y-auto overscroll-contain rounded-md border border-line bg-surface shadow-xl"
        >
          {/* hideEmpty guarantees items.length > 0 here, so skip the loading/empty rows */}
          {!hideEmpty && loading ? (
            <div className="px-3 py-2 text-xs text-muted">Загрузка…</div>
          ) : !hideEmpty && items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-faint">Ничего не найдено</div>
          ) : items.map(it => {
            const meta = renderMeta?.(it)
            return (
              <button
                key={it.id}
                type="button"
                onClick={() => choose(it)}
                className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm text-fg hover:bg-surface-2 transition-colors ${itemClassName?.(it) ?? ''}`}
              >
                <span className="flex-1 truncate">{it.name}</span>
                {meta && <span className="shrink-0 text-xs text-muted tabular-nums">{meta}</span>}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}
