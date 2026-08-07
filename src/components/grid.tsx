/* eslint-disable react-refresh/only-export-components -- shared grid helpers + cells live together */
import { useState, useRef, useEffect } from 'react'
import type { ChangeEvent } from 'react'
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

export function HeadCell({ label, className = '' }: { label: string; className?: string }) {
  return <div className={`px-2.5 py-2.5 text-xs font-bold uppercase tracking-wide text-fg border-r border-line ${className}`}>{label}</div>
}

// ─── Searchable dropdown cell (portal so it never gets clipped by the table) ──
// Generic over the option type so callers can carry extra fields (e.g. a product's
// price) while still displaying { id, name }.
export function SearchCell<T extends NamedOption>({
  value, onSelect, fetch, token, placeholder,
}: {
  value: T | null
  onSelect: (opt: T | null) => void
  fetch: (token: string, query: string) => Promise<T[]>
  token: string
  placeholder: string
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
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect())
    setOpen(true)
    runSearch(query)
  }

  function handleInput(v: string) {
    setQuery(v)
    onSelect(null)
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
      {open && rect && createPortal(
        <div
          data-search-menu
          style={{ position: 'fixed', top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 200) }}
          className="z-[1000] max-h-60 overflow-y-auto overscroll-contain rounded-md border border-line bg-surface shadow-xl"
        >
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted">Загрузка…</div>
          ) : items.length === 0 ? (
            <div className="px-3 py-2 text-xs text-faint">Ничего не найдено</div>
          ) : items.map(it => (
            <button
              key={it.id}
              type="button"
              onClick={() => choose(it)}
              className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-surface-2 transition-colors"
            >
              {it.name}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}
