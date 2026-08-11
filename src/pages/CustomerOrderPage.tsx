import { useState, useRef, useEffect } from 'react'
import { Plus, X, Loader2, Check } from 'lucide-react'
import {
  getOrganizations, getStores, searchCounterparties, searchProducts, createCustomerOrder,
  getCurrencies, getOrderStates, getUoms, getContracts, createContract, getAllContractNames,
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

// gutter · товар · количество · остаток · ед.изм · объём · цена за литр · сумма · удалить
const COLS = '44px 1.3fr 104px 110px 132px 116px 140px 150px 40px'

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
  // Создание нового договора прямо из виджета
  const [newContract, setNewContract] = useState<string | null>(null)  // null = форма закрыта
  const [contractBusy, setContractBusy] = useState(false)
  const [contractErr, setContractErr] = useState<string | null>(null)
  // Номера всех договоров — чтобы предупредить о повторе номера
  const [allContractNames, setAllContractNames] = useState<string[]>([])

  // Всплывающее уведомление после создания заказа (исчезает через 5 сек)
  const [toast, setToast] = useState<string | null>(null)

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

  // Live handle to rows, so the store-change effect below can read the current
  // products without re-running on every keystroke.
  const rowsRef = useRef(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

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
    getAllContractNames(token)
      .then(setAllContractNames)
      .catch(() => setAllContractNames([]))
  }, [token])

  // Уведомление о созданном заказе живёт 5 секунд.
  useEffect(() => {
    if (!toast) return
    const id = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(id)
  }, [toast])

  // Reload contracts whenever the counterparty (or legal entity) changes.
  useEffect(() => {
    let alive = true
    const load = agent ? getContracts(token, agent.id, orgId || undefined) : Promise.resolve([] as NamedOption[])
    load
      .then(cs => { if (!alive) return; setContracts(cs); setContractId(prev => (cs.some(c => c.id === prev) ? prev : '')) })
      .catch(() => { if (alive) { setContracts([]); setContractId('') } })
    return () => { alive = false }
  }, [token, agent, orgId])

  // When the warehouse changes, re-scope the stock of products already in the
  // grid to that store (re-uses the product search, which honours the store).
  useEffect(() => {
    const products = rowsRef.current.filter(r => r.product).map(r => r.product!)
    if (products.length === 0) return
    const uniq = Array.from(new Map(products.map(p => [p.id, p])).values())
    let alive = true
    Promise.all(uniq.map(async p => {
      const found = await searchProducts(token, p.name, storeId || undefined).catch(() => [] as ProductOption[])
      const match = found.find(x => x.id === p.id)
      return match ? [p.id, match.stock] as const : null
    })).then(pairs => {
      if (!alive) return
      const map = new Map(pairs.filter((x): x is readonly [string, number] => x !== null))
      if (map.size === 0) return
      setRows(rs => rs.map(r => (r.product && map.has(r.product.id)
        ? { ...r, product: { ...r.product, stock: map.get(r.product.id)! } } : r)))
    })
    return () => { alive = false }
  }, [token, storeId])

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
  // Цена за ОДНУ базовую единицу (шт) = объём(л за шт) × цена за литр, в долларах
  const unitPriceUsdOf = (r: Pos) => (r.product?.volume ?? 0) * r.pricePerLiter
  // Та же цена в валюте заказа (для сум умножаем на курс)
  const unitPriceMajorOf = (r: Pos) => (currency === 'UZS' ? unitPriceUsdOf(r) * rate : unitPriceUsdOf(r))
  // Сумма позиции = ОБЪЁМ (литраж) × ЦЕНА ЗА ЛИТР — точный расчёт, без потери копеек.
  const amountUsdOf = (r: Pos) => litersOf(r) * r.pricePerLiter
  const sumOf = (r: Pos) => (currency === 'UZS' ? amountUsdOf(r) * rate : amountUsdOf(r))
  const total = rows.reduce((s, r) => s + sumOf(r), 0)
  const totalUsd = currency === 'UZS' && rate > 0 ? total / rate : total
  const totalLiters = rows.reduce((s, r) => s + litersOf(r), 0)
  // Base unit label (e.g. шт) for a row's product
  const baseUnitLabel = (r: Pos) => (r.product?.uomId && uomName[r.product.uomId]) || 'шт'
  // Подпись упаковки с её размером из карточки товара: «коробка (8 шт)»
  const packLabel = (r: Pos, p: { id: string; quantity: number; uomId: string | null }) =>
    `${(p.uomId && uomName[p.uomId]) || 'упаковка'} (${p.quantity} ${baseUnitLabel(r)})`

  // Создание нового договора для выбранного контрагента.
  async function handleCreateContract() {
    const name = (newContract ?? '').trim()
    if (!name || !agent || !orgId) return
    setContractBusy(true); setContractErr(null)
    try {
      const created = await createContract(token, { name, agentId: agent.id, orgId })
      setContracts(cs => [...cs, created])
      setContractId(created.id)
      setAllContractNames(ns => [...ns, created.name])
      setNewContract(null)
    } catch (e) {
      setContractErr(e instanceof Error ? e.message : String(e))
    } finally {
      setContractBusy(false)
    }
  }
  // Номер уже занят? (сравниваем без учёта регистра и пробелов по краям)
  const contractDuplicate = !!newContract?.trim()
    && allContractNames.some(n => n.trim().toLowerCase() === newContract.trim().toLowerCase())
  // Выбранный статус — для окраски селекта в цвет МойСклад
  const selectedState = states.find(s => s.id === stateId) ?? null
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
          const factor = factorOf(r)   // штук в выбранной единице (коробка = N шт; шт = 1)
          return {
            assortmentId: r.product!.id,
            assortmentType: r.product!.type,
            // Количество в выбранной единице: в коробках, если выбрана коробка; иначе в штуках.
            quantity: r.quantity,
            // Цена за выбранную единицу = цена за штуку × штук в единице (за коробку/за штуку).
            // Так сумма в МойСклад = цена × количество, а коробки сохраняются.
            priceMajor: unitPriceMajorOf(r) * factor,
            // Упаковка: списание остатка идёт в штуках, а в заказе видно коробки.
            pack: pack
              ? { id: pack.id, quantity: pack.quantity, ...(pack.uomMeta ? { uom: { meta: pack.uomMeta } } : {}) }
              : undefined,
          }
        }),
      })
      const msg = `Заказ создан${doc.name ? ` № ${doc.name}` : ''}`
      setOkMsg(msg)
      setToast(msg)          // всплывающее окно, исчезнет через 5 сек
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
        <div className="flex items-center gap-1.5 text-xs text-muted">
          Договор:
          {newContract === null ? (
            <>
              <select
                value={contractId}
                onChange={e => setContractId(e.target.value)}
                disabled={!agent || contracts.length === 0}
                className={`${FIELD} max-w-[200px] disabled:opacity-50`}
              >
                <option value="">{!agent ? '— выберите контрагента —' : contracts.length === 0 ? '— нет договоров —' : '— не задан —'}</option>
                {contracts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => { setNewContract(''); setContractErr(null) }}
                disabled={!agent || !orgId}
                title={agent ? 'Создать договор' : 'Сначала выберите контрагента'}
                className="w-7 h-7 shrink-0 rounded-md border border-line flex items-center justify-center text-muted hover:text-accent hover:border-accent transition-colors disabled:opacity-40 disabled:hover:text-muted disabled:hover:border-line"
              >
                <Plus size={14} />
              </button>
            </>
          ) : (
            <>
              <input
                type="text"
                value={newContract}
                autoFocus
                onChange={e => setNewContract(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !contractDuplicate) handleCreateContract()
                  if (e.key === 'Escape') { setNewContract(null); setContractErr(null) }
                }}
                placeholder="Номер договора"
                className={`${FIELD} w-44 ${contractDuplicate ? 'border-red-500' : ''}`}
              />
              <button
                type="button"
                onClick={handleCreateContract}
                disabled={!newContract.trim() || contractBusy || contractDuplicate}
                title={contractDuplicate ? 'Такой номер уже существует' : 'Сохранить договор'}
                className="w-7 h-7 shrink-0 rounded-md bg-accent text-white flex items-center justify-center hover:bg-accent-strong transition-colors disabled:opacity-40"
              >
                {contractBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button
                type="button"
                onClick={() => { setNewContract(null); setContractErr(null) }}
                title="Отмена"
                className="w-7 h-7 shrink-0 rounded-md border border-line flex items-center justify-center text-muted hover:text-red-500 transition-colors"
              >
                <X size={14} />
              </button>
              {contractDuplicate && <span className="text-[11px] text-red-500">Номер уже занят</span>}
              {contractErr && <span className="text-[11px] text-red-500">{contractErr}</span>}
            </>
          )}
        </div>
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
          <span className="relative flex items-center">
            {/* Цветовая метка статуса — тот же цвет, что в МойСклад */}
            {selectedState && (
              <span
                className="absolute left-2 w-2.5 h-2.5 rounded-full pointer-events-none ring-1 ring-black/10"
                style={{ backgroundColor: selectedState.color }}
              />
            )}
            <select
              value={stateId}
              onChange={e => setStateId(e.target.value)}
              className={`${FIELD} max-w-[180px] ${selectedState ? 'pl-6' : ''}`}
              style={selectedState
                ? { color: selectedState.color, borderColor: selectedState.color, fontWeight: 600 }
                : undefined}
            >
              <option value="" style={{ color: 'inherit', fontWeight: 400 }}>— не задан —</option>
              {states.map(s => (
                <option key={s.id} value={s.id} style={{ color: s.color, fontWeight: 600 }}>{s.name}</option>
              ))}
            </select>
          </span>
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
        <div style={{ minWidth: 880 }} className="min-h-full flex flex-col">
          {/* Header */}
          <div className="grid sticky top-0 z-20 bg-surface-2 border-b border-line shadow-sm" style={{ gridTemplateColumns: COLS }}>
            <div className={GUTTER} />
            <HeadCell label="Товар" />
            <HeadCell label="Количество" className="text-right" />
            <HeadCell label="Остаток" className="text-right" />
            <HeadCell label="Ед. изм." />
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
                  fetch={(tok, q) => searchProducts(tok, q, storeId || undefined)}
                  token={token}
                  placeholder="Выберите товар…"
                  hideEmpty
                  renderMeta={p => `Ост: ${stockLabel(p)}`}
                  itemClassName={p => (p.stock <= 0 ? 'text-red-500 opacity-50' : '')}
                />
              </div>
              <div className={CELLBOX} title={packOf(r) ? `Количество в коробках · 1 коробка = ${factorOf(r)} ${baseUnitLabel(r)}` : undefined}>
                <GroupedNumberInput value={r.quantity} onChange={n => patchRow(r.key, { quantity: n })} placeholder="0" className={`${CELL} font-mono text-right`} />
              </div>
              <div className="border-r border-line bg-surface-2/40 flex items-center justify-end px-2.5">
                <span className={`font-mono text-sm tabular-nums ${r.product ? (r.product.stock <= 0 ? 'text-red-500 opacity-60' : 'text-muted') : 'text-faint'}`}>
                  {r.product ? stockLabel(r.product) : '—'}
                </span>
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
                    <option key={p.id} value={p.id}>{packLabel(r, p)}</option>
                  ))}
                </select>
              </div>
              <div className="border-r border-line bg-surface-2/40 flex items-center justify-end px-2.5">
                <span className="font-mono text-sm text-muted tabular-nums" title={r.product ? `${fmtMoney(r.product.volume)} л за ${baseUnitLabel(r)}` : undefined}>
                  {r.product ? `${fmtMoney(litersOf(r))} л` : '—'}
                </span>
              </div>
              <div className={CELLBOX}>
                <GroupedNumberInput
                  value={r.pricePerLiter}
                  onChange={n => patchRow(r.key, { pricePerLiter: n })}
                  placeholder="0"
                  decimalComma
                  className={`${CELL} font-mono text-right font-bold`}
                />
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
            <div className="col-span-7 px-2.5 py-2 text-sm text-faint">Добавить товар</div>
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
            <div className="border-r border-line" />
            <div />
          </div>

          {/* Totals */}
          <div className="grid sticky bottom-0 z-20 bg-surface-2 border-t border-line font-semibold" style={{ gridTemplateColumns: COLS }}>
            <div className={GUTTER} />
            <div className="px-2.5 py-2.5 border-r border-line text-xs uppercase tracking-wide text-muted">Итого</div>
            <div className="border-r border-line" />
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

      {/* Всплывающее уведомление о созданном заказе — само исчезает через 5 секунд */}
      {toast && (
        <div className="fixed inset-0 z-[2000] flex items-start justify-center pt-24 pointer-events-none">
          <div
            role="status"
            className="pointer-events-auto flex items-center gap-3 rounded-xl border border-green-500/30 bg-surface px-5 py-4 shadow-2xl"
          >
            <span className="w-9 h-9 shrink-0 rounded-full bg-green-500/15 flex items-center justify-center">
              <Check size={18} className="text-green-600" />
            </span>
            <div>
              <p className="text-sm font-semibold text-fg">{toast}</p>
              <p className="text-xs text-muted">Данные сохранены в МойСклад</p>
            </div>
            <button
              type="button"
              onClick={() => setToast(null)}
              title="Закрыть"
              className="ml-2 w-7 h-7 rounded flex items-center justify-center text-faint hover:text-fg hover:bg-surface-2 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
