import { useState, useRef, useEffect } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X } from 'lucide-react'
import { searchFirms, searchClients, type NamedOption } from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { ThemeToggle } from '../components/ThemeToggle'
import { GroupedNumberInput } from '../components/GroupedNumberInput'

// ─── Table model ────────────────────────────────────────────────────────────
interface Row {
  key: string
  date: string          // YYYY-MM-DD
  firm: NamedOption | null
  amount: number        // в валюте (сум)
  rate: number          // курс
  client: NamedOption | null
}

// Column layout — identical across header, rows and totals so everything lines up.
const COLS = '150px 1.5fr 160px 110px 160px 1.4fr 40px'

const CELL = 'w-full px-2 py-2.5 text-sm bg-transparent focus:outline-none focus:bg-accent/5 text-fg placeholder-faint'

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtUsd(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function HeadCell({ label, className = '' }: { label: string; className?: string }) {
  return <div className={`px-3 py-3 text-xs font-bold uppercase tracking-wide text-fg border-r border-line ${className}`}>{label}</div>
}

// ─── Searchable dropdown cell (portal so it never gets clipped by the table) ──
function SearchCell({
  value, onSelect, fetch, token, placeholder,
}: {
  value: NamedOption | null
  onSelect: (opt: NamedOption | null) => void
  fetch: (token: string, query: string) => Promise<NamedOption[]>
  token: string
  placeholder: string
}) {
  const [query, setQuery] = useState(value?.name ?? '')
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NamedOption[]>([])
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

  function choose(opt: NamedOption) {
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
    function onScrollResize() { setOpen(false) }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('scroll', onScrollResize, true)
    window.addEventListener('resize', onScrollResize)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('scroll', onScrollResize, true)
      window.removeEventListener('resize', onScrollResize)
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
          className="z-[1000] max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-line bg-surface shadow-xl"
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

export default function PaymentWidgetPage() {
  const { token } = useAppContext()
  const nextKey = useRef(1)

  const [rows, setRows] = useState<Row[]>([
    { key: 'row-0', date: todayStr(), firm: null, amount: 0, rate: 0, client: null },
  ])

  function addRow() {
    setRows(rs => [...rs, { key: `row-${nextKey.current++}`, date: todayStr(), firm: null, amount: 0, rate: 0, client: null }])
  }
  function removeRow(key: string) {
    setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : rs))
  }
  function patchRow(key: string, patch: Partial<Row>) {
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const usdOf = (r: Row) => (r.rate > 0 ? r.amount / r.rate : 0)
  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0)
  const totalUsd = rows.reduce((s, r) => s + usdOf(r), 0)

  return (
    <div className="fabric-bg h-screen flex flex-col overflow-hidden">
      <header className="shrink-0 bg-surface/70 backdrop-blur-md border-b border-line">
        <div className="px-6 h-14 flex items-center gap-4">
          <span className="m3-title-large text-fg">Разбивка платежа</span>
          <div className="flex-1" />
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 overflow-auto p-5">
        <div className="max-w-6xl mx-auto space-y-4">

          <div className="overflow-x-auto rounded-xl border border-line card-shadow bg-surface">
            <div style={{ minWidth: 980 }}>
              {/* Header */}
              <div className="grid bg-surface-2 border-b border-line" style={{ gridTemplateColumns: COLS }}>
                <HeadCell label="Дата" />
                <HeadCell label="Фирма" />
                <HeadCell label="Сумма" className="text-right" />
                <HeadCell label="Курс" className="text-right" />
                <HeadCell label="Сумма в $" className="text-right" />
                <HeadCell label="Клиент" />
                <div className="border-line" />
              </div>

              {/* Rows */}
              {rows.map(r => (
                <div key={r.key} className="grid border-b border-line hover:bg-surface-2/40 transition-colors" style={{ gridTemplateColumns: COLS }}>
                  <div className="border-r border-line">
                    <input
                      type="date"
                      value={r.date}
                      onChange={e => patchRow(r.key, { date: e.target.value })}
                      className={`${CELL} font-mono`}
                    />
                  </div>
                  <div className="border-r border-line">
                    <SearchCell
                      value={r.firm}
                      onSelect={opt => patchRow(r.key, { firm: opt })}
                      fetch={searchFirms}
                      token={token}
                      placeholder="Выберите фирму…"
                    />
                  </div>
                  <div className="border-r border-line">
                    <GroupedNumberInput
                      value={r.amount}
                      onChange={n => patchRow(r.key, { amount: n })}
                      placeholder="0"
                      className={`${CELL} font-mono text-right`}
                    />
                  </div>
                  <div className="border-r border-line">
                    <GroupedNumberInput
                      value={r.rate}
                      onChange={n => patchRow(r.key, { rate: n })}
                      placeholder="0"
                      className={`${CELL} font-mono text-right`}
                    />
                  </div>
                  <div className="border-r border-line bg-surface-2/40 flex items-center justify-end px-3">
                    <span className="font-mono text-sm text-muted tabular-nums">{fmtUsd(usdOf(r))}</span>
                  </div>
                  <div className="border-r border-line">
                    <SearchCell
                      value={r.client}
                      onSelect={opt => patchRow(r.key, { client: opt })}
                      fetch={searchClients}
                      token={token}
                      placeholder="Выберите клиента…"
                    />
                  </div>
                  <div className="flex items-center justify-center">
                    <button
                      type="button"
                      onClick={() => removeRow(r.key)}
                      disabled={rows.length === 1}
                      title="Удалить строку"
                      className="w-7 h-7 rounded-md flex items-center justify-center text-faint hover:text-red-500 hover:bg-red-500/10 transition-all disabled:opacity-30 disabled:hover:text-faint disabled:hover:bg-transparent"
                    >
                      <X size={15} />
                    </button>
                  </div>
                </div>
              ))}

              {/* Totals */}
              <div className="grid bg-surface-2 font-semibold" style={{ gridTemplateColumns: COLS }}>
                <div className="px-3 py-2.5 border-r border-line text-xs uppercase tracking-wide text-muted">Итого</div>
                <div className="border-r border-line" />
                <div className="px-3 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">{totalAmount.toLocaleString('ru-RU')}</div>
                <div className="border-r border-line" />
                <div className="px-3 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">{fmtUsd(totalUsd)}</div>
                <div className="border-r border-line" />
                <div />
              </div>
            </div>
          </div>

          {/* Add row */}
          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-line text-sm text-muted hover:border-accent hover:text-accent transition-all"
          >
            <Plus size={15} />
            Добавить строку
          </button>

          <div className="pt-2 flex flex-col gap-2">
            <button
              type="button"
              disabled
              className="w-full sm:w-auto px-6 py-3 rounded-xl bg-accent text-white font-semibold text-sm disabled:opacity-40"
            >
              Создать документы
            </button>
            <p className="text-xs text-faint">
              Демо-режим: данные пока не отправляются в МойСклад. Списки «Фирма» и «Клиент» заполнены тестовыми данными.
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}
