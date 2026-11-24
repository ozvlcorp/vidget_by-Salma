import { useState, useEffect, useMemo } from 'react'
import { Loader2, RefreshCw, Check } from 'lucide-react'
import {
  getSalesOrders, getOrderStates, updateOrderState,
  type SalesOrder, type OrderState,
} from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { HeadCell, GUTTER, todayStr, fmtMoney } from '../components/grid'
import { PERIODS, daysAgo } from '../lib/period'

const FIELD = 'h-9 lg:h-8 px-2 rounded-md border border-line bg-surface text-fg text-xs'
const COLS = '44px 110px minmax(180px, 1fr) 120px 150px 230px'

/** Результат последней попытки сменить статус у конкретной заявки. */
type Saving = { status: 'saving' } | { status: 'done' } | { status: 'error'; message: string }

/** «2026-11-24 14:05:00» → «24.11, 14:05» */
function shortMoment(m: string): string {
  const [date, time] = m.split(' ')
  const [, mo, d] = (date ?? '').split('-')
  return d && mo ? `${d}.${mo}${time ? `, ${time.slice(0, 5)}` : ''}` : m
}

/**
 * Выпадающий список статусов в цветах МойСклад. Вынесен наружу: объявленный
 * внутри страницы компонент пересоздавался бы на каждый рендер, и открытый
 * список закрывался бы сам.
 */
function StateSelect({
  states, value, saving, onChange,
}: {
  states: OrderState[]
  value: string
  saving?: Saving
  onChange: (stateId: string) => void
}) {
  const current = states.find(s => s.id === value) ?? null
  const busy = saving?.status === 'saving'
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="relative flex min-w-0 flex-1 items-center">
        {current && (
          <span
            className="pointer-events-none absolute left-2 h-2.5 w-2.5 rounded-full ring-1 ring-black/10"
            style={{ backgroundColor: current.color }}
          />
        )}
        <select
          value={value}
          disabled={busy || states.length === 0}
          onChange={e => onChange(e.target.value)}
          className={`${FIELD} w-full ${current ? 'pl-6' : ''} disabled:opacity-60`}
          style={current ? { color: current.color, borderColor: current.color, fontWeight: 600 } : undefined}
        >
          {!current && <option value="">— не задан —</option>}
          {states.map(s => (
            <option key={s.id} value={s.id} style={{ color: s.color, fontWeight: 600 }}>{s.name}</option>
          ))}
        </select>
      </span>
      {/* Место под значок сохранения всегда занято, чтобы список не прыгал */}
      <span className="flex w-4 shrink-0 justify-center">
        {busy && <Loader2 size={13} className="animate-spin text-accent" />}
        {saving?.status === 'done' && <Check size={14} className="text-green-600" />}
      </span>
    </span>
  )
}

/**
 * Список оформленных заявок со сменой статуса.
 *
 * Какие статусы доступны, задаёт бизнес-процесс аккаунта (справочник статусов
 * заказа), а можно ли менять документ — права самого сотрудника: запрос уходит
 * под его токеном, и отказ МойСклад показывается у строки.
 */
export default function OrdersPage() {
  const { token, userName } = useAppContext()
  const [from, setFrom] = useState(daysAgo(6))
  const [to, setTo] = useState(todayStr())
  const [onlyMine, setOnlyMine] = useState(true)
  const [orders, setOrders] = useState<SalesOrder[] | null>(null)
  const [states, setStates] = useState<OrderState[]>([])
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Статус, выбранный в строке, пока ответ МойСклад не пришёл.
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, Saving>>({})

  useEffect(() => {
    let alive = true
    setOrders(null)
    getSalesOrders(token, from, to)
      .then(rows => { if (alive) { setOrders(rows); setError(null) } })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setOrders([]) } })
    return () => { alive = false }
  }, [token, from, to, reloadKey])

  useEffect(() => {
    let alive = true
    getOrderStates(token)
      .then(ss => { if (alive) setStates(ss) })
      .catch(() => { if (alive) setStates([]) })
    return () => { alive = false }
  }, [token])

  const rows = useMemo(
    () => (orders ?? []).filter(o => !onlyMine || (userName && o.employee === userName)),
    [orders, onlyMine, userName],
  )

  const stateOf = (o: SalesOrder) => picked[o.id] ?? o.stateId ?? ''
  const stateById = (id: string) => states.find(s => s.id === id) ?? null

  async function changeState(o: SalesOrder, stateId: string) {
    const target = stateById(stateId)
    if (!target) return
    setPicked(p => ({ ...p, [o.id]: stateId }))
    setSaving(s => ({ ...s, [o.id]: { status: 'saving' } }))
    try {
      await updateOrderState(token, o.id, target.meta)
      setSaving(s => ({ ...s, [o.id]: { status: 'done' } }))
    } catch (e) {
      // Откатываем выбор: в МойСклад статус остался прежним.
      setPicked(p => { const n = { ...p }; delete n[o.id]; return n })
      setSaving(s => ({ ...s, [o.id]: { status: 'error', message: e instanceof Error ? e.message : String(e) } }))
    }
  }

  const errorOf = (o: SalesOrder) => {
    const st = saving[o.id]
    return st?.status === 'error' ? st.message : null
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-base text-fg">
      {/* Период и фильтр */}
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 overflow-x-hidden">
        {PERIODS.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => { setFrom(p.from()); setTo(todayStr()) }}
            className="h-9 lg:h-8 flex-1 lg:flex-none px-3 rounded-md border border-line text-xs text-muted hover:text-accent hover:border-accent transition-colors"
          >
            {p.label}
          </button>
        ))}
        <label className="flex flex-1 lg:flex-none items-center gap-1.5 text-xs text-muted">
          с
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={`${FIELD} min-w-0 flex-1 lg:flex-none font-mono`} />
        </label>
        <label className="flex flex-1 lg:flex-none items-center gap-1.5 text-xs text-muted">
          по
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className={`${FIELD} min-w-0 flex-1 lg:flex-none font-mono`} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
          <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} className="accent-accent" />
          Только мои
        </label>
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          title="Обновить"
          className="w-9 h-9 lg:w-8 lg:h-8 shrink-0 rounded-md border border-line flex items-center justify-center text-muted hover:text-accent hover:border-accent transition-colors"
        >
          <RefreshCw size={14} />
        </button>
        <div className="flex-1" />
        {orders === null && <Loader2 size={16} className="animate-spin text-accent" />}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {/* Телефон и планшет: карточками */}
        <div className="lg:hidden px-3 py-3 space-y-2">
          {rows.length === 0 ? (
            <div className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-faint">
              {orders === null ? 'Загрузка…' : 'За период заявок нет'}
            </div>
          ) : rows.map(o => (
            <div key={o.id} className="rounded-xl border border-line bg-surface p-3 space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-xs text-faint">{o.name}</span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{o.agentName}</span>
                <span className="font-mono text-sm font-bold tabular-nums text-fg">{fmtMoney(o.sumMajor)}</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <span>{shortMoment(o.moment)}</span>
                <span className="truncate">{o.employee}</span>
              </div>
              <div className="flex items-center gap-2"><StateSelect
                  states={states}
                  value={stateOf(o)}
                  saving={saving[o.id]}
                  onChange={id => changeState(o, id)}
                /></div>
              {errorOf(o) && <p className="text-xs text-red-600">{errorOf(o)}</p>}
            </div>
          ))}
        </div>

        {/* Широкий экран: таблицей */}
        <div className="hidden lg:block">
          <div className="grid sticky top-0 z-20 bg-surface-2 border-b border-line shadow-sm" style={{ gridTemplateColumns: COLS }}>
            <div className={GUTTER} />
            <HeadCell label="Номер" />
            <HeadCell label="Контрагент" />
            <HeadCell label="Дата" />
            <HeadCell label="Сумма" className="text-right" />
            <HeadCell label="Статус" />
          </div>
          {rows.length === 0 ? (
            <div className="bg-surface px-4 py-6 text-center text-sm text-faint">
              {orders === null ? 'Загрузка…' : 'За период заявок нет'}
            </div>
          ) : rows.map((o, i) => (
            <div key={o.id} className="grid border-b border-line bg-surface" style={{ gridTemplateColumns: COLS }}>
              <div className={GUTTER}>{i + 1}</div>
              <div className="px-2.5 py-2 border-r border-line font-mono text-sm tabular-nums">{o.name}</div>
              <div className="min-w-0 px-2.5 py-2 border-r border-line text-sm truncate" title={`${o.agentName} · ${o.employee}`}>
                {o.agentName}
              </div>
              <div className="px-2.5 py-2 border-r border-line font-mono text-sm tabular-nums text-muted">{shortMoment(o.moment)}</div>
              <div className="px-2.5 py-2 border-r border-line text-right font-mono text-sm tabular-nums">{fmtMoney(o.sumMajor)}</div>
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <StateSelect
                  states={states}
                  value={stateOf(o)}
                  saving={saving[o.id]}
                  onChange={id => changeState(o, id)}
                />
              </div>
              {errorOf(o) && (
                <div className="col-span-6 px-2.5 pb-2 text-xs text-red-600">{errorOf(o)}</div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Статус-строка */}
      <div className="shrink-0 border-t border-line bg-surface-2 px-3 py-1.5 text-[11px] text-faint">
        {error ? <span className="text-red-600">Ошибка: {error}</span>
          : <span>Заявок: {rows.length} · {onlyMine ? `только мои${userName ? ` · ${userName}` : ''}` : 'все сотрудники'}</span>}
      </div>
    </div>
  )
}
