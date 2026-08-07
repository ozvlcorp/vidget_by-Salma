import { useState, useRef, useEffect } from 'react'
import { Plus, X, Loader2 } from 'lucide-react'
import {
  getOrganizations, getStores, searchCounterparties, searchProducts, createCustomerOrder,
  getCurrencies, getOrderStates, getUoms, getContracts,
  type NamedOption, type OrganizationOption, type StoreOption, type ProductOption,
  type CurrencyRate, type OrderState,
} from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { GroupedNumberInput } from '../components/GroupedNumberInput'
import { CELL, CELLBOX, GUTTER, HeadCell, SearchCell, todayStr, fmtMoney } from '../components/grid'

type Cur = 'UZS' | 'USD'
const CURRENCIES: Array<{ value: Cur; label: string }> = [
  { value: 'UZS', label: 'сум' },
  { value: 'USD', label: 'доллар' },
]

// Position row: товар, ед.изм (шт/упаковка), количество, объём(л), цена за литр($), (сумма)
interface Pos {
  key: string
  product: ProductOption | null
  packId: string       // '' = базовая единица (шт); иначе id упаковки товара
  quantity: number
  pricePerLiter: number // «Цена за литр (доллар)» — из доп. поля товара, редактируемая
}

// gutter · товар · ед.изм · количество · объём · цена за литр · сумма · удалить
const COLS = '44px 1.3fr 120px 96px 116px 140px 150px 40px'

const FIELD = 'h-8 px-2 rounded-md border border-line bg-surface text-fg text-xs'

export default function CustomerOrderPage() {
  const { token } = useAppContext()
  const nextKey = useRef(1)

  const [organizations, setOrganizations] = useState<OrganizationOption[] | null>(null)
  const [orgId, setOrgId] = useState('')
  const [stores, setStores] = useState<StoreOption[] | null>(null)
  const [storeId, setStoreId] = useState('')
  const [agent, setAgent] = useState<NamedOption | null>(null)
  const [date, setDate] = useState(todayStr())

  // Договор (contract) — depends on the chosen counterparty + legal entity
  const [contracts, setContracts] = useState<NamedOption[]>([])
  const [contractId, setContractId] = useState('')

  // Currency: доллар (base USD) by default, since the price is per litre in dollars;
  // сум → order in UZS with a rate.
  const [currency, setCurrency] = useState<Cur>('USD')
  const [rate, setRate] = useState(0)
  const [uzsCurrency, setUzsCurrency] = useState<CurrencyRate | null>(null)

  // Status (Статус)
  const [states, setStates] = useState<OrderState[]>([])
  const [stateId, setStateId] = useState('')

  // Units of measure id → name (to label шт / коробка)
  const [uomName, setUomName] = useState<Record<string, string>>({})

  const [rows, setRows] = useState<Pos[]>([{ key: 'p-0', product: null, packId: '', quantity: 1, pricePerLiter: 0 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)

  useEffect(() => {
    getOrganizations(token)
      .then(orgs => { setOrganizations(orgs); if (orgs.length) setOrgId(prev => prev || orgs[0].id) })
      .catch(() => setOrganizations([]))
    getStores(token)
      .then(ss => { setStores(ss); if (ss.length) setStoreId(prev => prev || ss[0].id) })
      .catch(() => setStores([]))
    getCurrencies(token)
      .then(cs => setUzsCurrency(cs.find(c => c.isoCode === 'UZS') ?? null))
      .catch(() => setUzsCurrency(null))
    getOrderStates(token)
      .then(setStates)
      .catch(() => setStates([]))
    getUoms(token)
      .then(us => setUomName(Object.fromEntries(us.map(u => [u.id, u.name]))))
      .catch(() => setUomName({}))
  }, [token])

  // Reload contracts whenever the counterparty (or legal entity) changes.
  useEffect(() => {
    let alive = true
    const load = agent ? getContracts(token, agent.id, orgId || undefined) : Promise.resolve([] as NamedOption[])
    load
      .then(cs => { if (!alive) return; setContracts(cs); setContractId(prev => (cs.some(c => c.id === prev) ? prev : '')) })
      .catch(() => { if (alive) { setContracts([]); setContractId('') } })
    return () => { alive = false }
  }, [token, agent, orgId])

  function freshRow(): Pos {
    return { key: `p-${nextKey.current++}`, product: null, packId: '', quantity: 1, pricePerLiter: 0 }
  }
  function addRow() { setOkMsg(null); setRows(rs => [...rs, freshRow()]) }
  function removeRow(key: string) { setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : rs)) }
  function patchRow(key: string, patch: Partial<Pos>) {
    setOkMsg(null)
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }
  // Picking a product fills the price-per-litre from its card and defaults the unit
  // to the first pack (коробка) when the product has one.
  function pickProduct(key: string, p: ProductOption | null) {
    patchRow(key, { product: p, pricePerLiter: p?.pricePerLiter ?? 0, packId: p?.packs[0]?.id ?? '' })
  }

  // Base units per selected unit: pack quantity when a pack is chosen, else 1.
  const packOf = (r: Pos) => r.product?.packs.find(p => p.id === r.packId) ?? null
  const factorOf = (r: Pos) => packOf(r)?.quantity ?? 1
  const baseQtyOf = (r: Pos) => r.quantity * factorOf(r)     // всего базовых единиц (шт)
  // Литраж позиции: объём из карточки (за 1 шт) × количество в базовых единицах
  const litersOf = (r: Pos) => (r.product?.volume ?? 0) * baseQtyOf(r)
  // Сумма позиции = литраж × цена за литр (в долларах), затем в валюту заказа
  const amountUsdOf = (r: Pos) => litersOf(r) * r.pricePerLiter
  const sumOf = (r: Pos) => (currency === 'UZS' ? amountUsdOf(r) * rate : amountUsdOf(r))
  const total = rows.reduce((s, r) => s + sumOf(r), 0)
  const totalUsd = rows.reduce((s, r) => s + amountUsdOf(r), 0)
  const totalLiters = rows.reduce((s, r) => s + litersOf(r), 0)
  // Base unit label (e.g. шт) for a row's product
  const baseUnitLabel = (r: Pos) => (r.product?.uomId && uomName[r.product.uomId]) || 'шт'
  // Остаток label for the product dropdown: "25 шт"
  const stockLabel = (p: ProductOption) => {
    const unit = (p.uomId && uomName[p.uomId]) || 'шт'
    return `${p.stock.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ${unit}`
  }
  const validRows = rows.filter(r => r.product && r.quantity > 0)
  const needsRate = currency === 'UZS'
  const canSubmit = !submitting && !!orgId && !!agent && validRows.length > 0
    && (!needsRate || (!!uzsCurrency && rate > 0))

  async function handleSubmit() {
    if (!agent) return
    setSubmitting(true); setError(null); setOkMsg(null)
    try {
      const state = states.find(s => s.id === stateId)
      const doc = await createCustomerOrder(token, {
        organizationId: orgId,
        agentId: agent.id,
        storeId: storeId || undefined,
        moment: `${date} 12:00:00`,
        // сум → document currency = сум with rate 1/Курс; доллар → base currency
        currencyId: currency === 'UZS' ? uzsCurrency?.id : undefined,
        rateValue: currency === 'UZS' ? 1 / rate : undefined,
        stateMeta: state?.meta,
        contractId: contractId || undefined,
        positions: validRows.map(r => {
          const pack = packOf(r)
          // Цена за базовую единицу (шт) = объём(л за шт) × цена за литр, в валюте заказа
          const priceUsdPerUnit = (r.product!.volume ?? 0) * r.pricePerLiter
          const priceMajor = currency === 'UZS' ? priceUsdPerUnit * rate : priceUsdPerUnit
          return {
            assortmentId: r.product!.id,
            assortmentType: r.product!.type,
            quantity: r.quantity,   // в упаковках, если выбрана упаковка; иначе в базовых единицах
            priceMajor,
            pack: pack
              ? { id: pack.id, quantity: pack.quantity, ...(pack.uomMeta ? { uom: { meta: pack.uomMeta } } : {}) }
              : undefined,
          }
        }),
      })
      setOkMsg(`Заказ создан${doc.name ? ` № ${doc.name}` : ''}`)
      // Reset to an empty order
      setRows([freshRow()])
      setAgent(null)
      setContractId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-base text-fg">
      {/* Order header */}
      <div className="shrink-0 border-b border-line bg-surface px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Юр. лицо:
          {organizations === null ? <span className="text-faint">…</span> : (
            <select value={orgId} onChange={e => setOrgId(e.target.value)} className={`${FIELD} max-w-[200px]`}>
              {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Склад:
          {stores === null ? <span className="text-faint">…</span> : stores.length === 0 ? <span className="text-faint">нет</span> : (
            <select value={storeId} onChange={e => setStoreId(e.target.value)} className={`${FIELD} max-w-[180px]`}>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Дата:
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`${FIELD} font-mono`} />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Контрагент:
          <div className="w-52 rounded-md border border-line bg-surface">
            <SearchCell value={agent} onSelect={setAgent} fetch={searchCounterparties} token={token} placeholder="Выберите контрагента…" />
          </div>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Договор:
          <select
            value={contractId}
            onChange={e => setContractId(e.target.value)}
            disabled={!agent || contracts.length === 0}
            className={`${FIELD} max-w-[200px] disabled:opacity-50`}
          >
            <option value="">{!agent ? '— выберите контрагента —' : contracts.length === 0 ? '— нет договоров —' : '— не задан —'}</option>
            {contracts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Валюта:
          <select value={currency} onChange={e => setCurrency(e.target.value as Cur)} className={FIELD}>
            {CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        {currency === 'UZS' && (
          <label className="flex items-center gap-1.5 text-xs text-muted">
            Курс:
            <div className="w-24 rounded-md border border-line bg-surface">
              <GroupedNumberInput value={rate} onChange={setRate} placeholder="0" className={`${CELL} font-mono text-right`} />
            </div>
          </label>
        )}
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Статус:
          <select value={stateId} onChange={e => setStateId(e.target.value)} className={`${FIELD} max-w-[180px]`}>
            <option value="">— не задан —</option>
            {states.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <div className="flex-1" />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex items-center gap-1.5 h-8 px-4 rounded-md bg-accent text-white text-xs font-semibold hover:bg-accent-strong transition-all disabled:opacity-40"
        >
          {submitting && <Loader2 size={13} className="animate-spin" />}
          {submitting ? 'Создание…' : 'Создать заказ'}
        </button>
      </div>

      {/* Positions grid */}
      <div className="flex-1 overflow-auto">
        <div style={{ minWidth: 760 }} className="min-h-full flex flex-col">
          {/* Header */}
          <div className="grid sticky top-0 z-20 bg-surface-2 border-b border-line shadow-sm" style={{ gridTemplateColumns: COLS }}>
            <div className={GUTTER} />
            <HeadCell label="Товар" />
            <HeadCell label="Ед. изм." />
            <HeadCell label="Количество" className="text-right" />
            <HeadCell label="Объём, л" className="text-right" />
            <HeadCell label="Цена за литр, $" className="text-right" />
            <HeadCell label="Сумма" className="text-right" />
            <div className="border-line" />
          </div>

          {/* Rows */}
          {rows.map((r, i) => (
            <div key={r.key} className="grid border-b border-line bg-surface hover:bg-surface-2/40 transition-colors" style={{ gridTemplateColumns: COLS }}>
              <div className={GUTTER}>{i + 1}</div>
              <div className={CELLBOX}>
                <SearchCell
                  value={r.product}
                  onSelect={p => pickProduct(r.key, p)}
                  fetch={searchProducts}
                  token={token}
                  placeholder="Выберите товар…"
                  hideEmpty
                  renderMeta={p => `Ост: ${stockLabel(p)}`}
                  itemClassName={p => (p.stock < 0 ? 'text-red-500 opacity-50' : '')}
                />
              </div>
              <div className={CELLBOX}>
                <select
                  value={r.packId}
                  onChange={e => patchRow(r.key, { packId: e.target.value })}
                  disabled={!r.product}
                  className={`${CELL} cursor-pointer disabled:cursor-not-allowed`}
                >
                  <option value="">{baseUnitLabel(r)}</option>
                  {(r.product?.packs ?? []).map(p => (
                    <option key={p.id} value={p.id}>{(p.uomId && uomName[p.uomId]) || 'упаковка'}</option>
                  ))}
                </select>
              </div>
              <div className={CELLBOX}>
                <GroupedNumberInput value={r.quantity} onChange={n => patchRow(r.key, { quantity: n })} placeholder="0" className={`${CELL} font-mono text-right`} />
              </div>
              <div className="border-r border-line bg-surface-2/40 flex items-center justify-end px-2.5">
                <span className="font-mono text-sm text-muted tabular-nums" title={r.product ? `${fmtMoney(r.product.volume)} л за шт` : undefined}>
                  {r.product ? `${fmtMoney(litersOf(r))} л` : '—'}
                </span>
              </div>
              <div className={CELLBOX}>
                <GroupedNumberInput value={r.pricePerLiter} onChange={n => patchRow(r.key, { pricePerLiter: n })} placeholder="0" className={`${CELL} font-mono text-right`} />
              </div>
              <div className="border-r border-line bg-surface-2/40 flex items-center justify-end px-2.5">
                <span className="font-mono text-sm text-muted tabular-nums">{fmtMoney(sumOf(r))}</span>
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
          ))}

          {/* Add-row strip */}
          <button
            type="button"
            onClick={addRow}
            className="grid w-full text-left border-b border-line bg-surface hover:bg-surface-2/50 transition-colors"
            style={{ gridTemplateColumns: COLS }}
          >
            <div className={GUTTER}><Plus size={13} /></div>
            <div className="col-span-6 px-2.5 py-2 text-sm text-faint">Добавить товар</div>
            <div />
          </button>

          {/* Blank canvas */}
          <div className="grid flex-1 bg-surface" style={{ gridTemplateColumns: COLS }} aria-hidden="true">
            <div className={GUTTER} />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div />
          </div>

          {/* Totals */}
          <div className="grid sticky bottom-0 z-20 bg-surface-2 border-t border-line font-semibold" style={{ gridTemplateColumns: COLS }}>
            <div className={GUTTER} />
            <div className="px-2.5 py-2.5 border-r border-line text-xs uppercase tracking-wide text-muted">Итого</div>
            <div className="border-r border-line" />
            <div className="border-r border-line" />
            <div className="px-2.5 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">{fmtMoney(totalLiters)} л</div>
            <div className="border-r border-line" />
            <div className="px-2.5 py-2.5 border-r border-line text-right font-mono text-sm text-fg tabular-nums">{fmtMoney(total)}</div>
            <div />
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div className="shrink-0 h-7 flex items-center gap-4 px-3 border-t border-line bg-surface-2 text-[11px] text-faint">
        <span>Позиций: {rows.length}</span>
        <span className="tabular-nums">
          Итого: {fmtMoney(total)} {currency === 'UZS' ? 'сум' : '$'}
          {currency === 'UZS' && rate > 0 && <> · ${fmtMoney(totalUsd)}</>}
          {' · '}Объём: {fmtMoney(totalLiters)} л
        </span>
        <div className="flex-1" />
        {okMsg && <span className="text-green-600">✓ {okMsg}</span>}
        {error && <span className="text-red-600">Ошибка: {error}</span>}
        {!okMsg && !error && <span>Заказ покупателя · МойСклад</span>}
      </div>
    </div>
  )
}
