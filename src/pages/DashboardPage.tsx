import { useState, useEffect, useMemo } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { getSalesOrders, getCurrencies, type SalesOrder, type CurrencyRate } from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { HeadCell, GUTTER, todayStr, fmtMoney } from '../components/grid'

const FIELD = 'h-9 lg:h-8 px-2 rounded-md border border-line bg-surface text-fg text-xs'

/** Первый день текущего месяца в формате YYYY-MM-DD. */
function monthStart(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const PERIODS = [
  { id: 'today', label: 'Сегодня', from: () => todayStr() },
  { id: 'week', label: '7 дней', from: () => daysAgo(6) },
  { id: 'month', label: 'Этот месяц', from: () => monthStart() },
] as const

const fmtNum = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })

const AGENT_COLS = '44px minmax(220px, 1fr) 90px 130px 120px 150px'

interface SummaryRow { name: string; orders: number; liters: number; boxes: number; sum: number }

/**
 * Одна сводка: на широком экране — таблица, на телефоне — карточки, потому что
 * шесть столбцов в 375 точек не помещаются даже мелким шрифтом.
 */
function Summary({
  title, nameLabel, curLabel, rows, empty, className = 'pb-3',
}: {
  title: string
  nameLabel: string
  curLabel: string
  rows: SummaryRow[]
  empty: string
  className?: string
}) {
  return (
    <div className={`px-3 ${className}`}>
      <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">{title}</h2>

      {/* Телефон и планшет */}
      <div className="lg:hidden space-y-2">
        {rows.length === 0 ? (
          <div className="rounded-xl border border-line bg-surface px-4 py-6 text-center text-sm text-faint">{empty}</div>
        ) : rows.map((r, i) => (
          <div key={r.name} className="rounded-xl border border-line bg-surface p-3">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-faint">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{r.name}</span>
              <span className="font-mono text-sm font-bold tabular-nums text-fg">
                {fmtMoney(r.sum)} {curLabel}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
              <span className="tabular-nums">Литров: <span className="text-fg">{fmtNum(r.liters)}</span></span>
              <span className="tabular-nums">Коробок: <span className="text-fg">{fmtNum(r.boxes)}</span></span>
              <span className="tabular-nums">Заказов: <span className="text-fg">{r.orders}</span></span>
            </div>
          </div>
        ))}
      </div>

      {/* Широкий экран */}
      <div className="hidden lg:block rounded-xl border border-line overflow-hidden">
        <div className="grid bg-surface-2 border-b border-line" style={{ gridTemplateColumns: AGENT_COLS }}>
          <div className={GUTTER} />
          <HeadCell label={nameLabel} />
          <HeadCell label="Заказов" className="text-right" />
          <HeadCell label="Литров" className="text-right" />
          <HeadCell label="Коробок" className="text-right" />
          <HeadCell label={`Сумма, ${curLabel}`} className="text-right" />
        </div>
        {rows.length === 0 ? (
          <div className="bg-surface px-4 py-6 text-center text-sm text-faint">{empty}</div>
        ) : rows.map((r, i) => (
          <div key={r.name} className="grid border-b border-line last:border-b-0 bg-surface" style={{ gridTemplateColumns: AGENT_COLS }}>
            <div className={GUTTER}>{i + 1}</div>
            <div className="px-2.5 py-2 text-sm border-r border-line truncate" title={r.name}>{r.name}</div>
            <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{r.orders}</div>
            <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{fmtNum(r.liters)} л</div>
            <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{fmtNum(r.boxes)}</div>
            <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums">{fmtMoney(r.sum)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DashboardPage() {
  const { token, userName } = useAppContext()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(todayStr())
  const [onlyMine, setOnlyMine] = useState(true)
  const [orders, setOrders] = useState<SalesOrder[] | null>(null)
  // Заказы бывают и в сумах, и в долларах — приводим всё к одной валюте.
  const [currencies, setCurrencies] = useState<CurrencyRate[]>([])
  const [view, setView] = useState<'USD' | 'UZS'>('USD')
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    getSalesOrders(token, from, to)
      .then(rows => { if (alive) { setOrders(rows); setError(null) } })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setOrders([]) } })
    return () => { alive = false }
  }, [token, from, to, reloadKey])

  useEffect(() => {
    let alive = true
    getCurrencies(token)
      .then(cs => { if (alive) setCurrencies(cs) })
      .catch(() => { if (alive) setCurrencies([]) })
    return () => { alive = false }
  }, [token])

  // CurrencyRate.rate = единиц валюты учёта за 1 единицу этой валюты,
  // поэтому сумма в учёте, делённая на курс, даёт сумму в нужной валюте.
  const viewRate = currencies.find(c => c.isoCode === view)?.rate ?? 0
  const toView = viewRate > 0 ? 1 / viewRate : 1
  const curLabel = view === 'USD' ? '$' : 'сум'

  // «Только мои» сравнивает по ФИО из комментария документа.
  const rows = useMemo(
    () => (orders ?? []).filter(o => !onlyMine || (userName && o.employee === userName)),
    [orders, onlyMine, userName],
  )

  const total = useMemo(() => rows.reduce((acc, o) => ({
    liters: acc.liters + o.liters,
    boxes: acc.boxes + o.boxes,
    sum: acc.sum + o.baseSumMajor * toView,
  }), { liters: 0, boxes: 0, sum: 0 }), [rows, toView])

  // Кому продали: сводка по контрагентам
  const byAgent = useMemo(() => {
    const map = new Map<string, { agent: string; orders: number; liters: number; boxes: number; sum: number }>()
    for (const o of rows) {
      const cur = map.get(o.agentName) ?? { agent: o.agentName, orders: 0, liters: 0, boxes: 0, sum: 0 }
      cur.orders += 1; cur.liters += o.liters; cur.boxes += o.boxes; cur.sum += o.baseSumMajor * toView
      map.set(o.agentName, cur)
    }
    return [...map.values()].sort((a, b) => b.liters - a.liters)
  }, [rows, toView])

  // Кто продал: сводка по сотрудникам (полезна, когда смотрим всех)
  const byEmployee = useMemo(() => {
    const map = new Map<string, { employee: string; orders: number; liters: number; boxes: number; sum: number }>()
    for (const o of rows) {
      const cur = map.get(o.employee) ?? { employee: o.employee, orders: 0, liters: 0, boxes: 0, sum: 0 }
      cur.orders += 1; cur.liters += o.liters; cur.boxes += o.boxes; cur.sum += o.baseSumMajor * toView
      map.set(o.employee, cur)
    }
    return [...map.values()].sort((a, b) => b.liters - a.liters)
  }, [rows, toView])


  return (
    <div className="h-full flex flex-col overflow-hidden bg-base text-fg">
      {/* Панель периода */}
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
        <div className="flex items-center rounded-md border border-line overflow-hidden">
          {(['USD', 'UZS'] as const).map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setView(c)}
              className={`h-9 lg:h-8 px-4 lg:px-3 text-xs transition-colors ${
                view === c ? 'bg-accent text-white' : 'text-muted hover:text-fg'
              }`}
            >
              {c === 'USD' ? '$' : 'сум'}
            </button>
          ))}
        </div>
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
        {/* Итоги */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 p-3">
          {[
            { label: 'Продано литров', value: `${fmtNum(total.liters)} л` },
            { label: 'Продано коробок', value: fmtNum(total.boxes) },
            { label: `Сумма заказов, ${curLabel}`, value: fmtMoney(total.sum) },
            { label: 'Заказов', value: String(rows.length) },
          ].map(card => (
            <div key={card.label} className="rounded-xl border border-line bg-surface px-4 py-3">
              <p className="text-[11px] uppercase tracking-wide text-muted">{card.label}</p>
              <p className="mt-1 text-xl lg:text-2xl font-bold tabular-nums text-fg break-words">{card.value}</p>
            </div>
          ))}
        </div>

        {/* Кому продали */}
        <Summary
          title="Кому продали"
          nameLabel="Контрагент"
          curLabel={curLabel}
          rows={byAgent.map(a => ({ name: a.agent, orders: a.orders, liters: a.liters, boxes: a.boxes, sum: a.sum }))}
          empty={orders === null ? 'Загрузка…' : 'За период продаж нет'}
        />

        {/* Кто продал — при просмотре всех сотрудников */}
        {!onlyMine && byEmployee.length > 0 && (
          <Summary
            title="Кто продал"
            nameLabel="Сотрудник"
            curLabel={curLabel}
            rows={byEmployee.map(e => ({ name: e.employee, orders: e.orders, liters: e.liters, boxes: e.boxes, sum: e.sum }))}
            empty=""
            className="pb-6"
          />
        )}
      </div>

      {/* Телефон: из статус-строки нужна только ошибка */}
      {error && (
        <div className="lg:hidden shrink-0 border-t border-line bg-surface px-3 py-2 text-xs text-red-600">
          Ошибка: {error}
        </div>
      )}

      {/* Статус-строка (широкий экран) */}
      <div className="hidden lg:flex shrink-0 h-7 items-center gap-4 px-3 border-t border-line bg-surface-2 text-[11px] text-faint">
        <span>{onlyMine ? `Мои продажи${userName ? ` · ${userName}` : ''}` : 'Продажи всех сотрудников'}</span>
        <div className="flex-1" />
        {error && <span className="text-red-600">Ошибка: {error}</span>}
        {!error && <span>Заказы покупателей · МойСклад</span>}
      </div>
    </div>
  )
}
