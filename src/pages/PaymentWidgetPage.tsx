import { useState, useRef, useEffect } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X, Loader2 } from 'lucide-react'
import {
  searchCounterparties, getOrganizations, createPaymentDocument, getCurrencies,
  getDocAttributes, buildFromWhomAttribute, searchFromWhomValues, msMoment, resolveDocCurrency,
  type NamedOption, type OrganizationOption, type PaymentDocType, type CurrencyRate, type DocAttribute,
} from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { ThemeToggle } from '../components/ThemeToggle'
import { GroupedNumberInput } from '../components/GroupedNumberInput'
import { CELL, CELLBOX, GUTTER, HeadCell, SearchCell, todayStr, fmtMoney, useColumnWidths } from '../components/grid'

// ─── Table model ────────────────────────────────────────────────────────────
type Cur = 'UZS' | 'USD'   // сум или доллар

interface Row {
  key: string
  date: string          // YYYY-MM-DD
  firm: string          // название фирмы — свободный ввод (нет в МоемСкладе)
  currency: Cur         // валюта суммы: сум или доллар
  amount: number        // сумма в выбранной валюте
  rate: number          // курс (только для сум)
  client: NamedOption | null   // контрагент из МоегоСклада
  type: PaymentDocType         // 'cashin' | 'paymentin'
}

type RowResult = { status: 'success' | 'error'; message?: string; link?: string | null; warning?: string }

const PAYMENT_TYPES: Array<{ value: PaymentDocType; label: string }> = [
  { value: 'cashin', label: 'Наличные' },       // Приходный ордер
  { value: 'paymentin', label: 'Перечисление' }, // Входящий платёж
]

const CURRENCIES: Array<{ value: Cur; label: string }> = [
  { value: 'UZS', label: 'сум' },
  { value: 'USD', label: 'доллар' },
]

// Column layout — identical across header, rows and totals so everything lines up.
// Leading 44px = Excel-style row-number gutter; trailing 40px = delete control.
// Ширины тянутся мышкой за границу в шапке:
// дата · фирма · валюта · сумма · курс · сумма в $ · контрагенты · тип
const DEFAULT_COL_WIDTHS = [142, 300, 92, 130, 88, 124, 300, 166]

const fmtUsd = fmtMoney

// ─── Фирма cell — free text with suggestions from the "От кого" справочник ────
function FirmCell({
  value, onChange, fetchSuggestions, placeholder,
}: {
  value: string
  onChange: (text: string) => void
  fetchSuggestions: (query: string) => Promise<NamedOption[]>
  placeholder: string
}) {
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
      fetchSuggestions(q).then(setItems).finally(() => setLoading(false))
    }, 200)
  }
  function openMenu() {
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect())
    setOpen(true)
    runSearch(value)
  }
  function handleInput(v: string) {
    onChange(v)
    if (inputRef.current) setRect(inputRef.current.getBoundingClientRect())
    setOpen(true)
    runSearch(v)
  }
  function choose(name: string) {
    onChange(name)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    function onDocDown(e: MouseEvent) {
      const t = e.target as HTMLElement
      if (inputRef.current && !inputRef.current.contains(t) && !t.closest('[data-firm-menu]')) setOpen(false)
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
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => handleInput(e.target.value)}
        onFocus={openMenu}
        placeholder={placeholder}
        className={CELL}
      />
      {open && rect && (loading || items.length > 0) && createPortal(
        <div
          data-firm-menu
          style={{ position: 'fixed', top: rect.bottom + 2, left: rect.left, width: Math.max(rect.width, 220) }}
          className="z-[1000] max-h-60 overflow-y-auto overscroll-contain rounded-md border border-line bg-surface shadow-xl"
        >
          {loading ? (
            <div className="px-3 py-2 text-xs text-muted">Загрузка…</div>
          ) : items.map(it => (
            <button
              key={it.id}
              type="button"
              onClick={() => choose(it.name)}
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
  const { token, userName } = useAppContext()
  const nextKey = useRef(1)

  // Ширины столбцов + перетаскивание границ (сохраняются между сессиями).
  // Все столбцы фиксированные — тогда любая колонка тянется ровно так, как задал
  // пользователь; свободное место справа забирает пустая колонка в конце.
  const { widths, startResize, resetWidths } = useColumnWidths('oy-payment-cols', DEFAULT_COL_WIDTHS)
  const COLS = `44px ${widths.map(w => `${w}px`).join(' ')} 40px minmax(0, 1fr)`

  const [rows, setRows] = useState<Row[]>([
    { key: 'row-0', date: todayStr(), firm: '', currency: 'UZS', amount: 0, rate: 0, client: null, type: 'cashin' },
  ])

  const [organizations, setOrganizations] = useState<OrganizationOption[] | null>(null)
  const [orgId, setOrgId] = useState('')
  // Весь справочник валют: валюта учёта аккаунта может быть и сум, и доллар,
  // от неё зависит, нужно ли вообще указывать валюту и курс в документе.
  const [allCurrencies, setAllCurrencies] = useState<CurrencyRate[]>([])
  // The "От кого" доп. поле per document type (its id differs between cashin/paymentin)
  const [fromWhomAttrs, setFromWhomAttrs] = useState<Record<PaymentDocType, DocAttribute | null>>({ cashin: null, paymentin: null })
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<Record<string, RowResult>>({})
  const [savedCount, setSavedCount] = useState(0)

  useEffect(() => {
    getOrganizations(token)
      .then(orgs => {
        setOrganizations(orgs)
        if (orgs.length > 0) setOrgId(prev => prev || orgs[0].id)
      })
      .catch(() => setOrganizations([]))
    getCurrencies(token)
      .then(setAllCurrencies)
      .catch(() => setAllCurrencies([]))
    for (const t of ['cashin', 'paymentin'] as PaymentDocType[]) {
      getDocAttributes(token, t)
        .then(attrs => {
          const found = attrs.find(a => /от\s*кого/i.test(a.name)) ?? null
          setFromWhomAttrs(prev => ({ ...prev, [t]: found }))
        })
        .catch(() => { /* leave null */ })
    }
  }, [token])

  function addRow() {
    setSavedCount(0)
    setRows(rs => [...rs, freshRow()])
  }
  function removeRow(key: string) {
    setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : rs))
    setResults(rs => { if (!(key in rs)) return rs; const n = { ...rs }; delete n[key]; return n })
  }
  function patchRow(key: string, patch: Partial<Row>) {
    setSavedCount(0)
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  // USD equivalent: доллар → amount as-is; сум → amount / Курс.
  const usdOf = (r: Row) => (r.currency === 'USD' ? r.amount : (r.rate > 0 ? r.amount / r.rate : 0))
  const totalUsd = rows.reduce((s, r) => s + usdOf(r), 0)

  // A row is ready to save when it has a counterparty, a positive amount, and —
  // for сум — a positive conversion rate (доллар is the base currency, no rate).
  const validRows = rows.filter(r => r.client && r.amount > 0 && (r.currency === 'USD' || r.rate > 0))
  const needsUzs = validRows.some(r => r.currency === 'UZS')
  const canSubmit = !submitting && !!orgId && validRows.length > 0 && (!needsUzs || allCurrencies.length > 0)
  // Почему кнопка неактивна — показываем рядом с ней. Самая частая причина:
  // контрагент напечатан, но не выбран из списка, поэтому строка не считается готовой.
  const missingClient = rows.some(r => !r.client && (r.amount > 0 || r.firm.trim()))
  const missingRate = rows.some(r => r.client && r.amount > 0 && r.currency === 'UZS' && r.rate <= 0)
  const submitBlocker = !orgId ? 'Выберите юр. лицо'
    : missingClient ? 'Выберите контрагента из списка'
    : missingRate ? 'Укажите курс для строк в сумах'
    : validRows.length === 0 ? 'Заполните строку: контрагент и сумма'
    : null

  function freshRow(): Row {
    return { key: `row-${nextKey.current++}`, date: todayStr(), firm: '', currency: 'UZS', amount: 0, rate: 0, client: null, type: 'cashin' }
  }

  async function handleSubmit() {
    if (needsUzs && allCurrencies.length === 0) return
    setSubmitting(true)
    setResults({})
    setSavedCount(0)

    // Sequential (not parallel) so MoySklad assigns sequential document numbers —
    // concurrent creates can collide on the same number.
    const entries: Array<[string, RowResult]> = []
    for (const row of validRows) {
      try {
        // Company name → the "От кого" доп. поле (find-or-create the value in its справочник)
        const firmText = row.firm.trim()
        const attr = fromWhomAttrs[row.type]
        const attributes = firmText && attr
          ? [await buildFromWhomAttribute(token, row.type, attr, firmText)]
          : undefined

        const doc = await createPaymentDocument(token, {
          type: row.type,
          organizationId: orgId,
          agentId: row.client!.id,
          sumMajor: row.amount,
          // Валюта и курс зависят от валюты учёта аккаунта: если валюта строки
          // и есть валюта учёта, блок валюты не отправляем вовсе.
          ...resolveDocCurrency(allCurrencies, row.currency, row.rate),
          attributes,
          moment: msMoment(row.date),
          // Автором в МойСклад числится токен, поэтому ФИО оформившего пишем в комментарий.
          description: userName ? `Оформил: ${userName}` : undefined,
        })
        entries.push([row.key, {
          status: 'success',
          link: doc.uuidHref,
          // Документ прошёл, но «Фирму» записать не дали — сообщаем, а не молчим.
          warning: doc.firmSkipped && firmText
            ? 'Документ создан, но «Фирма» не сохранена: у роли нет прав на доп. поле «От кого»'
            : undefined,
        }])
      } catch (e) {
        entries.push([row.key, { status: 'error', message: e instanceof Error ? e.message : String(e) }])
      }
    }

    const res = Object.fromEntries(entries)
    const errors = entries.filter(([, r]) => r.status === 'error').length
    setSubmitting(false)

    if (errors === 0) {
      setRows([freshRow()])
      // Строки очищаем, но предупреждения оставляем — иначе сотрудник не узнает,
      // что «Фирма» не записалась.
      setResults(Object.fromEntries(entries.filter(([, r]) => r.warning)))
      setSavedCount(entries.length)
    } else {
      setResults(res)
    }
  }

  const errorCount = Object.values(results).filter(r => r.status === 'error').length
  // Текст первой ошибки виден сразу — раньше он прятался в подсказке и сотрудник
  // видел только слово «ошибка».
  const firstError = Object.values(results).find(r => r.status === 'error')?.message ?? null
  const firstWarning = Object.values(results).find(r => r.warning)?.warning ?? null

  const gutter = GUTTER

  return (
    <div className="h-full flex flex-col overflow-hidden bg-base text-fg">
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
        {/* Кнопка неактивна — сразу говорим, чего не хватает. */}
        {!submitting && submitBlocker && (
          <span className="text-xs text-amber-600">{submitBlocker}</span>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          title={submitBlocker ?? 'Создать документы в МойСклад'}
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
        <div style={{ minWidth: widths.reduce((s, w) => s + w, 0) + 84 }} className="min-h-full flex flex-col">
          {/* Header (frozen) */}
          <div className="grid sticky top-0 z-20 bg-surface-2 border-b border-line shadow-sm" style={{ gridTemplateColumns: COLS }}>
            <div className={gutter} />
            <HeadCell label="Дата" onResizeStart={startResize(0)} />
            <HeadCell label="Фирма" onResizeStart={startResize(1)} />
            <HeadCell label="Валюта" onResizeStart={startResize(2)} />
            <HeadCell label="Сумма" className="text-right" onResizeStart={startResize(3)} />
            <HeadCell label="Курс" className="text-right" onResizeStart={startResize(4)} />
            <HeadCell label="Сумма в $" className="text-right" onResizeStart={startResize(5)} />
            <HeadCell label="Контрагенты" onResizeStart={startResize(6)} />
            <HeadCell label="Тип" onResizeStart={startResize(7)} />
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
                <FirmCell
                  value={r.firm}
                  onChange={text => patchRow(r.key, { firm: text })}
                  fetchSuggestions={q => searchFromWhomValues(token, fromWhomAttrs[r.type], q)}
                  placeholder="Введите или выберите фирму…"
                />
              </div>
              <div className={CELLBOX}>
                <select
                  value={r.currency}
                  onChange={e => patchRow(r.key, { currency: e.target.value as Cur })}
                  className={`${CELL} cursor-pointer`}
                >
                  {CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              <div className={CELLBOX}>
                <GroupedNumberInput value={r.amount} onChange={n => patchRow(r.key, { amount: n })} placeholder="0" className={`${CELL} font-mono text-right`} />
              </div>
              <div className={`${CELLBOX} ${r.currency === 'USD' ? 'bg-surface-2/60' : ''}`}>
                <GroupedNumberInput
                  value={r.rate}
                  onChange={n => patchRow(r.key, { rate: n })}
                  disabled={r.currency === 'USD'}
                  placeholder="0"
                  className={`${CELL} font-mono text-right disabled:cursor-not-allowed disabled:text-faint`}
                />
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
            <div className="col-span-8 px-2.5 py-2 text-sm text-faint">Добавить строку</div>
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
            <div className="border-r border-line" />
            <div />
          </div>

          {/* Totals (frozen at bottom) */}
          <div className="grid sticky bottom-0 z-20 bg-surface-2 border-t border-line font-semibold" style={{ gridTemplateColumns: COLS }}>
            <div className={gutter} />
            <div className="px-2.5 py-2.5 border-r border-line text-xs uppercase tracking-wide text-muted">Итого</div>
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="px-2.5 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">$ {fmtUsd(totalUsd)}</div>
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div />
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="shrink-0 h-7 flex items-center gap-4 px-3 border-t border-line bg-surface-2 text-[11px] text-faint">
        <span>Строк: {rows.length}</span>
        <span className="tabular-nums">Итого $ {fmtUsd(totalUsd)}</span>
        <button
          type="button"
          onClick={resetWidths}
          title="Вернуть исходную ширину столбцов"
          className="text-faint hover:text-accent hover:underline transition-colors"
        >
          Сбросить ширину столбцов
        </button>
        <div className="flex-1" />
        {savedCount > 0 && <span className="text-green-600">✓ Создано документов: {savedCount}</span>}
        {errorCount > 0 && (
          <span className="text-red-600 truncate" title={firstError ?? undefined}>
            Ошибок: {errorCount}{firstError ? ` · ${firstError}` : ''}
          </span>
        )}
        {firstWarning && <span className="text-amber-600 truncate" title={firstWarning}>{firstWarning}</span>}
        {savedCount === 0 && errorCount === 0 && (
          <span>{allCurrencies.length > 0 ? 'Готово к отправке в МойСклад' : 'Справочник валют не загружен'}</span>
        )}
      </div>
    </div>
  )
}
