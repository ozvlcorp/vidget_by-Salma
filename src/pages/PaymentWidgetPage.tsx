import { useState, useRef, useEffect } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, Loader2 } from 'lucide-react'
import {
  searchCounterparties, getOrganizations, createPaymentDocument,
  type NamedOption, type OrganizationOption, type PaymentDocType,
} from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { ThemeToggle } from '../components/ThemeToggle'
import { GroupedNumberInput } from '../components/GroupedNumberInput'

// ─── Table model ────────────────────────────────────────────────────────────
interface Row {
  key: string
  date: string          // YYYY-MM-DD
  firm: string          // название фирмы — свободный ввод (нет в МоемСкладе)
  amount: number        // в валюте (сум)
  rate: number          // курс
  client: NamedOption | null   // контрагент из МоегоСклада
  type: PaymentDocType         // 'cashin' | 'paymentin'
}

type RowResult = { status: 'success' | 'error'; message?: string; link?: string | null }

const PAYMENT_TYPES: Array<{ value: PaymentDocType; label: string }> = [
  { value: 'cashin', label: 'Приходный ордер' },
  { value: 'paymentin', label: 'Входящий платёж' },
]

// Column layout — identical across header, rows and totals so everything lines up.
// Leading 44px = Excel-style row-number gutter; trailing 40px = delete control.
const COLS = '44px 132px 1.3fr 150px 96px 140px 1.3fr 180px 40px'

const CELL = 'w-full px-2.5 py-2 text-sm bg-transparent focus:outline-none text-fg placeholder-faint'
// Editable cell wrapper: right gridline + Excel "active cell" ring on focus.
const CELLBOX = 'relative border-r border-line focus-within:z-10 focus-within:ring-2 focus-within:ring-accent focus-within:ring-inset'

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtUsd(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function HeadCell({ label, className = '' }: { label: string; className?: string }) {
  return <div className={`px-2.5 py-2.5 text-xs font-bold uppercase tracking-wide text-fg border-r border-line ${className}`}>{label}</div>
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

export default function PaymentWidgetPage() {
  const { token } = useAppContext()
  const nextKey = useRef(1)

  const [rows, setRows] = useState<Row[]>([
    { key: 'row-0', date: todayStr(), firm: '', amount: 0, rate: 0, client: null, type: 'cashin' },
  ])

  const [organizations, setOrganizations] = useState<OrganizationOption[] | null>(null)
  const [orgId, setOrgId] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<Record<string, RowResult>>({})

  useEffect(() => {
    getOrganizations(token).then(setOrganizations).catch(() => setOrganizations([]))
  }, [token])

  useEffect(() => {
    if (organizations && organizations.length > 0 && !orgId) setOrgId(organizations[0].id)
  }, [organizations, orgId])

  function addRow() {
    setRows(rs => [...rs, { key: `row-${nextKey.current++}`, date: todayStr(), firm: '', amount: 0, rate: 0, client: null, type: 'cashin' }])
  }
  function removeRow(key: string) {
    setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : rs))
    setResults(rs => { if (!(key in rs)) return rs; const n = { ...rs }; delete n[key]; return n })
  }
  function patchRow(key: string, patch: Partial<Row>) {
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const usdOf = (r: Row) => (r.rate > 0 ? r.amount / r.rate : 0)
  const totalAmount = rows.reduce((s, r) => s + (r.amount || 0), 0)
  const totalUsd = rows.reduce((s, r) => s + usdOf(r), 0)

  // A row is ready to save once it has a counterparty and a positive amount.
  const validRows = rows.filter(r => r.client && r.amount > 0)
  const canSubmit = !submitting && !!orgId && validRows.length > 0

  async function handleSubmit() {
    setSubmitting(true)
    setResults({})
    await Promise.all(validRows.map(async row => {
      try {
        const doc = await createPaymentDocument(token, {
          type: row.type,
          organizationId: orgId,
          agentId: row.client!.id,
          sumMajor: row.amount,
          paymentPurpose: row.firm.trim() || undefined,
          moment: `${row.date} 12:00:00`,
        })
        setResults(prev => ({ ...prev, [row.key]: { status: 'success', link: doc.uuidHref } }))
      } catch (e) {
        setResults(prev => ({ ...prev, [row.key]: { status: 'error', message: e instanceof Error ? e.message : String(e) } }))
      }
    }))
    setSubmitting(false)
  }

  const successCount = Object.values(results).filter(r => r.status === 'success').length
  const errorCount = Object.values(results).filter(r => r.status === 'error').length

  const gutter = 'flex items-center justify-center bg-surface-2 border-r border-line text-xs text-faint font-mono select-none'

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-base text-fg">
      {/* Toolbar */}
      <div className="shrink-0 h-12 flex items-center gap-2 px-3 border-b border-line bg-surface">
        <span className="font-bold text-sm tracking-tight">Разбивка платежа</span>
        <div className="flex-1" />
        {/* Юр. лицо (organization) — applied to every created document */}
        <label className="hidden sm:flex items-center gap-1.5 text-xs text-muted">
          Юр. лицо:
          {organizations === null ? (
            <span className="text-faint">загрузка…</span>
          ) : organizations.length === 0 ? (
            <span className="text-faint">не найдено</span>
          ) : (
            <select
              value={orgId}
              onChange={e => setOrgId(e.target.value)}
              className="h-8 max-w-[220px] px-2 rounded-md border border-line bg-surface text-fg text-xs"
            >
              {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </label>
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1.5 h-8 px-3 rounded-md border border-line text-xs font-medium text-muted hover:border-accent hover:text-accent transition-all"
        >
          <Plus size={14} /> Строка
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 h-8 px-4 rounded-md bg-accent text-white text-xs font-semibold hover:bg-accent-strong transition-all disabled:opacity-40"
        >
          {submitting && <Loader2 size={13} className="animate-spin" />}
          {submitting ? 'Создание…' : 'Создать документы'}
        </button>
        <div className="w-px h-6 bg-line mx-1" />
        <ThemeToggle />
      </div>

      {/* Grid — fills the rest of the screen */}
      <div className="flex-1 overflow-auto">
        <div style={{ minWidth: 940 }} className="min-h-full flex flex-col">
          {/* Header (frozen) */}
          <div className="grid sticky top-0 z-20 bg-surface-2 border-b border-line shadow-sm" style={{ gridTemplateColumns: COLS }}>
            <div className={gutter} />
            <HeadCell label="Дата" />
            <HeadCell label="Фирма" />
            <HeadCell label="Сумма" className="text-right" />
            <HeadCell label="Курс" className="text-right" />
            <HeadCell label="Сумма в $" className="text-right" />
            <HeadCell label="Контрагенты" />
            <HeadCell label="Тип" />
            <div className="border-line" />
          </div>

          {/* Rows */}
          {rows.map((r, i) => {
            const res = results[r.key]
            const gutterState = res?.status === 'success'
              ? 'bg-green-500/15 text-green-600'
              : res?.status === 'error'
                ? 'bg-red-500/15 text-red-600'
                : ''
            return (
            <div key={r.key} className="grid border-b border-line bg-surface hover:bg-surface-2/40 transition-colors" style={{ gridTemplateColumns: COLS }}>
              <div className={`${gutter} ${gutterState}`} title={res?.message}>
                {res?.status === 'success' ? '✓' : res?.status === 'error' ? '✕' : i + 1}
              </div>
              <div className={CELLBOX}>
                <input
                  type="date"
                  value={r.date}
                  onChange={e => patchRow(r.key, { date: e.target.value })}
                  className={`${CELL} font-mono`}
                />
              </div>
              <div className={CELLBOX}>
                <input
                  type="text"
                  value={r.firm}
                  onChange={e => patchRow(r.key, { firm: e.target.value })}
                  placeholder="Введите название фирмы…"
                  className={CELL}
                />
              </div>
              <div className={CELLBOX}>
                <GroupedNumberInput value={r.amount} onChange={n => patchRow(r.key, { amount: n })} placeholder="0" className={`${CELL} font-mono text-right`} />
              </div>
              <div className={CELLBOX}>
                <GroupedNumberInput value={r.rate} onChange={n => patchRow(r.key, { rate: n })} placeholder="0" className={`${CELL} font-mono text-right`} />
              </div>
              <div className="border-r border-line bg-surface-2/40 flex items-center justify-end px-2.5">
                <span className="font-mono text-sm text-muted tabular-nums">{fmtUsd(usdOf(r))}</span>
              </div>
              <div className={CELLBOX}>
                <SearchCell value={r.client} onSelect={opt => patchRow(r.key, { client: opt })} fetch={searchCounterparties} token={token} placeholder="Выберите контрагента…" />
              </div>
              <div className={CELLBOX}>
                <select
                  value={r.type}
                  onChange={e => patchRow(r.key, { type: e.target.value as PaymentDocType })}
                  className={`${CELL} cursor-pointer`}
                >
                  {PAYMENT_TYPES.map(pt => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                </select>
              </div>
              <div className="flex items-center justify-center bg-surface">
                <button
                  type="button"
                  onClick={() => removeRow(r.key)}
                  disabled={rows.length === 1}
                  title="Удалить строку"
                  className="w-7 h-7 rounded flex items-center justify-center text-faint hover:text-red-500 hover:bg-red-500/10 transition-all disabled:opacity-30 disabled:hover:text-faint disabled:hover:bg-transparent"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )})}

          {/* Add-row strip */}
          <button
            type="button"
            onClick={addRow}
            className="grid w-full text-left border-b border-line bg-surface hover:bg-surface-2/50 transition-colors"
            style={{ gridTemplateColumns: COLS }}
          >
            <div className={gutter}><Plus size={13} /></div>
            <div className="col-span-7 px-2.5 py-2 text-sm text-faint">Добавить строку</div>
            <div />
          </button>

          {/* Blank spreadsheet canvas — continues the column gridlines to the bottom */}
          <div className="grid flex-1 bg-surface" style={{ gridTemplateColumns: COLS }} aria-hidden="true">
            <div className={gutter} />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div />
          </div>

          {/* Totals (frozen at bottom) */}
          <div className="grid sticky bottom-0 z-20 bg-surface-2 border-t border-line font-semibold" style={{ gridTemplateColumns: COLS }}>
            <div className={gutter} />
            <div className="px-2.5 py-2.5 border-r border-line text-xs uppercase tracking-wide text-muted">Итого</div>
            <div className="border-r border-line" />
            <div className="px-2.5 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">{totalAmount.toLocaleString('ru-RU')}</div>
            <div className="border-r border-line" />
            <div className="px-2.5 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">{fmtUsd(totalUsd)}</div>
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div />
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="shrink-0 h-7 flex items-center gap-4 px-3 border-t border-line bg-surface-2 text-[11px] text-faint">
        <span>Строк: {rows.length}</span>
        <span className="tabular-nums">Итого: {totalAmount.toLocaleString('ru-RU')} · $ {fmtUsd(totalUsd)}</span>
        <div className="flex-1" />
        {successCount > 0 && <span className="text-green-600">Создано: {successCount}</span>}
        {errorCount > 0 && <span className="text-red-600">Ошибок: {errorCount}</span>}
        {successCount === 0 && errorCount === 0 && <span>Готово к отправке в МойСклад</span>}
      </div>
    </div>
  )
}
