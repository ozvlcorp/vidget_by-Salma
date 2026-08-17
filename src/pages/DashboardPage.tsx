import { useState, useEffect, useMemo } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { getSalesOrders, type SalesOrder } from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { HeadCell, GUTTER, todayStr, fmtMoney } from '../components/grid'

const FIELD = 'h-8 px-2 rounded-md border border-line bg-surface text-fg text-xs'

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

export default function DashboardPage() {
  const { token, userName } = useAppContext()
  const [from, setFrom] = useState(monthStart())
  const [to, setTo] = useState(todayStr())
  const [onlyMine, setOnlyMine] = useState(true)
  const [orders, setOrders] = useState<SalesOrder[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    setOrders(null); setError(null)
    getSalesOrders(token, from, to)
      .then(rows => { if (alive) setOrders(rows) })
      .catch(e => { if (alive) { setError(e instanceof Error ? e.message : String(e)); setOrders([]) } })
    return () => { alive = false }
  }, [token, from, to, reloadKey])

  // «Только мои» сравнивает по ФИО из комментария документа.
  const rows = useMemo(
    () => (orders ?? []).filter(o => !onlyMine || (userName && o.employee === userName)),
    [orders, onlyMine, userName],
  )

  const total = useMemo(() => rows.reduce((acc, o) => ({
    liters: acc.liters + o.liters,
    boxes: acc.boxes + o.boxes,
    sum: acc.sum + o.sumMajor,
  }), { liters: 0, boxes: 0, sum: 0 }), [rows])

  // Кому продали: сводка по контрагентам
  const byAgent = useMemo(() => {
    const map = new Map<string, { agent: string; orders: number; liters: number; boxes: number; sum: number }>()
    for (const o of rows) {
      const cur = map.get(o.agentName) ?? { agent: o.agentName, orders: 0, liters: 0, boxes: 0, sum: 0 }
      cur.orders += 1; cur.liters += o.liters; cur.boxes += o.boxes; cur.sum += o.sumMajor
      map.set(o.agentName, cur)
    }
    return [...map.values()].sort((a, b) => b.liters - a.liters)
  }, [rows])

  // Кто продал: сводка по сотрудникам (полезна, когда смотрим всех)
  const byEmployee = useMemo(() => {
    const map = new Map<string, { employee: string; orders: number; liters: number; boxes: number; sum: number }>()
    for (const o of rows) {
      const cur = map.get(o.employee) ?? { employee: o.employee, orders: 0, liters: 0, boxes: 0, sum: 0 }
      cur.orders += 1; cur.liters += o.liters; cur.boxes += o.boxes; cur.sum += o.sumMajor
      map.set(o.employee, cur)
    }
    return [...map.values()].sort((a, b) => b.liters - a.liters)
  }, [rows])

  const AGENT_COLS = '44px minmax(220px, 1fr) 90px 130px 120px 150px'

  return (
    <div className="h-full flex flex-col overflow-hidden bg-base text-fg">
      {/* Панель периода */}
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        {PERIODS.map(p => (
          <button
            key={p.id}
            type="button"
            onClick={() => { setFrom(p.from()); setTo(todayStr()) }}
            className="h-8 px-3 rounded-md border border-line text-xs text-muted hover:text-accent hover:border-accent transition-colors"
          >
            {p.label}
          </button>
        ))}
        <label className="flex items-center gap-1.5 text-xs text-muted">
          с
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} className={`${FIELD} font-mono`} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          по
          <input type="date" value={to} onChange={e => setTo(e.target.value)} className={`${FIELD} font-mono`} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
          <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} className="accent-accent" />
          Только мои
        </label>
        <button
          type="button"
          onClick={() => setReloadKey(k => k + 1)}
          title="Обновить"
          className="w-8 h-8 rounded-md border border-line flex items-center justify-center text-muted hover:text-accent hover:border-accent transition-colors"
        >
          <RefreshCw size={14} />
        </button>
        <div className="flex-1" />
        {orders === null && <Loader2 size={16} className="animate-spin text-accent" />}
      </div>

      <div className="flex-1 overflow-auto">
        {/* Итоги */}
        <div className="grid gap-3 p-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
          {[
            { label: 'Продано литров', value: `${fmtNum(total.liters)} л` },
            { label: 'Продано коробок', value: fmtNum(total.boxes) },
            { label: 'Сумма заказов', value: fmtMoney(total.sum) },
            { label: 'Заказов', value: String(rows.length) },
          ].map(card => (
            <div key={card.label} className="rounded-xl border border-line bg-surface px-4 py-3">
              <p className="text-[11px] uppercase tracking-wide text-muted">{card.label}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-fg">{card.value}</p>
            </div>
          ))}
        </div>

        {/* Кому продали */}
        <div className="px-3 pb-3">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Кому продали</h2>
          <div className="rounded-xl border border-line overflow-hidden">
            <div className="grid bg-surface-2 border-b border-line" style={{ gridTemplateColumns: AGENT_COLS }}>
              <div className={GUTTER} />
              <HeadCell label="Контрагент" />
              <HeadCell label="Заказов" className="text-right" />
              <HeadCell label="Литров" className="text-right" />
              <HeadCell label="Коробок" className="text-right" />
              <HeadCell label="Сумма" className="text-right" />
            </div>
            {byAgent.length === 0 ? (
              <div className="bg-surface px-4 py-6 text-center text-sm text-faint">
                {orders === null ? 'Загрузка…' : 'За период продаж нет'}
              </div>
            ) : byAgent.map((a, i) => (
              <div key={a.agent} className="grid border-b border-line last:border-b-0 bg-surface" style={{ gridTemplateColumns: AGENT_COLS }}>
                <div className={GUTTER}>{i + 1}</div>
                <div className="px-2.5 py-2 text-sm border-r border-line truncate" title={a.agent}>{a.agent}</div>
                <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{a.orders}</div>
                <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{fmtNum(a.liters)} л</div>
                <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{fmtNum(a.boxes)}</div>
                <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums">{fmtMoney(a.sum)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Кто продал — при просмотре всех сотрудников */}
        {!onlyMine && byEmployee.length > 0 && (
          <div className="px-3 pb-6">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">Кто продал</h2>
            <div className="rounded-xl border border-line overflow-hidden">
              <div className="grid bg-surface-2 border-b border-line" style={{ gridTemplateColumns: AGENT_COLS }}>
                <div className={GUTTER} />
                <HeadCell label="Сотрудник" />
                <HeadCell label="Заказов" className="text-right" />
                <HeadCell label="Литров" className="text-right" />
                <HeadCell label="Коробок" className="text-right" />
                <HeadCell label="Сумма" className="text-right" />
              </div>
              {byEmployee.map((e, i) => (
                <div key={e.employee} className="grid border-b border-line last:border-b-0 bg-surface" style={{ gridTemplateColumns: AGENT_COLS }}>
                  <div className={GUTTER}>{i + 1}</div>
                  <div className="px-2.5 py-2 text-sm border-r border-line truncate" title={e.employee}>{e.employee}</div>
                  <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{e.orders}</div>
                  <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{fmtNum(e.liters)} л</div>
                  <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums border-r border-line">{fmtNum(e.boxes)}</div>
                  <div className="px-2.5 py-2 text-sm text-right font-mono tabular-nums">{fmtMoney(e.sum)}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Статус-строка */}
      <div className="shrink-0 h-7 flex items-center gap-4 px-3 border-t border-line bg-surface-2 text-[11px] text-faint">
        <span>{onlyMine ? `Мои продажи${userName ? ` · ${userName}` : ''}` : 'Продажи всех сотрудников'}</span>
        <div className="flex-1" />
        {error && <span className="text-red-600">Ошибка: {error}</span>}
        {!error && <span>Заказы покупателей · МойСклад</span>}
      </div>
    </div>
  )
}
