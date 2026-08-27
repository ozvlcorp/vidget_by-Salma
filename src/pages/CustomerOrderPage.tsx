import { useState, useRef, useEffect } from 'react'
import { Plus, X, Loader2, Check, ChevronDown, Trash2 } from 'lucide-react'
import {
  getOrganizations, getStores, searchCounterparties, searchProducts, createCustomerOrder,
  getCurrencies, getOrderStates, getUoms, getContracts, createContract, getAllContractNames, msMoment,
  resolveDocCurrency, getDocAttributes, getDictValues, buildDictAttribute, buildTextAttribute,
  type NamedOption, type OrganizationOption, type StoreOption, type ProductOption,
  type CurrencyRate, type OrderState, type DocAttribute, type DictOption,
} from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { GroupedNumberInput } from '../components/GroupedNumberInput'
import { CELL, CELLBOX, GUTTER, HeadCell, MField, MStat, SearchCell, todayStr, fmtMoney, useColumnWidths } from '../components/grid'

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

// Статусы новой заявки: только эти два, «Новый заказ» — по умолчанию.
// Порядок в списке — как здесь.
// `\w` в JS — только латиница, поэтому по кириллице сопоставляем через `.`
const NEW_ORDER_STATES = [/нов.*заказ/i, /черновик/i]

/** Отбирает разрешённые статусы в заданном порядке. Пусто → в аккаунте их нет. */
function pickOrderStates(all: OrderState[]): OrderState[] {
  return NEW_ORDER_STATES
    .map(re => all.find(s => re.test(s.name)))
    .filter((s): s is OrderState => !!s)
}

// Ширины столбцов (тянутся мышкой за границу в шапке):
// товар · количество · остаток · ед.изм · объём · цена за литр · сумма
const DEFAULT_COL_WIDTHS = [420, 104, 110, 132, 116, 140, 150]

const FIELD = 'h-9 lg:h-8 px-2 rounded-md border border-line bg-surface text-fg text-xs'
// Строка «подпись — поле» в шапке: на телефоне во всю ширину, на десктопе — в ряд.
const HEAD_LABEL = 'flex w-full lg:w-auto items-center justify-between lg:justify-start gap-2 text-xs text-muted'
// Сам ввод: на телефоне занимает правую половину строки, на десктопе — по контенту.
const HEAD_INPUT = 'min-w-0 flex-1 lg:flex-none'

export default function CustomerOrderPage() {
  const { token, userName } = useAppContext()
  const nextKey = useRef(1)
  // Телефон: параметры заказа занимают целый экран, поэтому их можно свернуть.
  const [paramsOpen, setParamsOpen] = useState(true)

  // Ширины столбцов + перетаскивание границ (сохраняются между сессиями).
  // Все столбцы фиксированные — тогда «Товар» тянется ровно так, как задал
  // пользователь; свободное место справа забирает пустая колонка в конце.
  const { widths, startResize, resetWidths } = useColumnWidths('oy-order-cols', DEFAULT_COL_WIDTHS)
  const COLS = `44px ${widths.map(w => `${w}px`).join(' ')} 40px minmax(0, 1fr)`

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
  // Весь справочник валют: по нему определяется валюта учёта аккаунта.
  const [allCurrencies, setAllCurrencies] = useState<CurrencyRate[]>([])

  // Status (Статус)
  const [states, setStates] = useState<OrderState[]>([])
  const [stateId, setStateId] = useState('')
  // Статус новой заявки — к нему форма возвращается после создания заказа.
  const [defaultStateId, setDefaultStateId] = useState('')

  // Доп. поле «Вид товара» — берём его из метаданных заказа, чтобы виджет
  // подхватил поле сам, без зашитого id. Справочник → выпадающий список,
  // строка/текст → обычный ввод.
  const [kindAttr, setKindAttr] = useState<DocAttribute | null>(null)
  const [kindValues, setKindValues] = useState<DictOption[]>([])
  const [kindId, setKindId] = useState('')      // выбранный элемент справочника
  const [kindText, setKindText] = useState('')  // значение для текстового поля

  // Units of measure id → name (to label шт / коробка)
  const [uomName, setUomName] = useState<Record<string, string>>({})

  const [rows, setRows] = useState<Pos[]>([{ key: 'p-0', product: null, packId: '', quantity: 1, pricePerLiter: 0 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  // Заказ создан, но какое-то необязательное поле записать не дали.
  const [warn, setWarn] = useState<string | null>(null)

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
      .then(setAllCurrencies)
      .catch(() => setAllCurrencies([]))
    getOrderStates(token)
      .then(all => {
        // Обычно оставляем «Новый заказ» и «Черновик», первый — по умолчанию.
        // Если их в аккаунте нет (переименовали), показываем все и не выбираем.
        const allowed = pickOrderStates(all)
        setStates(allowed.length ? allowed : all)
        setDefaultStateId(allowed[0]?.id ?? '')
        if (allowed.length) setStateId(prev => prev || allowed[0].id)
      })
      .catch(() => setStates([]))
    getUoms(token)
      .then(us => setUomName(Object.fromEntries(us.map(u => [u.id, u.name]))))
      .catch(() => setUomName({}))
    getAllContractNames(token)
      .then(setAllContractNames)
      .catch(() => setAllContractNames([]))
  }, [token])

  // Доп. поле «Вид товара»: ищем по названию, затем — значения его справочника.
  useEffect(() => {
    let alive = true
    getDocAttributes(token, 'customerorder')
      .then(async attrs => {
        const attr = attrs.find(a => /вид\s*товара/i.test(a.name)) ?? null
        if (!alive) return
        setKindAttr(attr)
        const values = attr ? await getDictValues(token, 'customerorder', attr).catch(() => []) : []
        if (alive) setKindValues(values)
      })
      .catch(() => { if (alive) { setKindAttr(null); setKindValues([]) } })
    return () => { alive = false }
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
  // Цена за литр задана в долларах, поэтому для документа в сумах курс обязателен.
  const needsRate = currency === 'UZS'
  const canSubmit = !submitting && !!orgId && !!agent && validRows.length > 0
    && (!needsRate || rate > 0)
  // Почему кнопка неактивна — показываем рядом с ней.
  const submitBlocker = !orgId ? 'Выберите юр. лицо'
    : !agent ? 'Выберите контрагента из списка'
    : validRows.length === 0 ? 'Добавьте товар и количество'
    : needsRate && rate <= 0 ? 'Укажите курс'
    : null
  // Подпись валюты для итоговых сумм: цена всегда в долларах, а сумма — в валюте заказа.
  const sumCurLabel = currency === 'UZS' ? 'сум' : '$'

  async function handleSubmit() {
    if (!agent) return
    setSubmitting(true); setError(null); setOkMsg(null); setWarn(null)
    try {
      const state = states.find(s => s.id === stateId)
      const doc = await createCustomerOrder(token, {
        attributes: kindAttribute(),
        organizationId: orgId,
        agentId: agent.id,
        storeId: storeId || undefined,
        moment: msMoment(date),
        // Валюта документа и курс зависят от валюты учёта аккаунта:
        // если выбранная валюта и есть валюта учёта — блок валюты не отправляем.
        ...resolveDocCurrency(allCurrencies, currency, rate),
        stateMeta: state?.meta,
        contractId: contractId || undefined,
        // Автором в МойСклад числится токен, поэтому ФИО оформившего пишем в комментарий.
        description: userName ? `Оформил: ${userName}` : undefined,
        positions: validRows.map(r => ({
          assortmentId: r.product!.id,
          assortmentType: r.product!.type,
          // Количество в ШТУКАХ: коробки раскладываем по размеру упаковки из
          // карточки (10 коробок × 8 шт = 80 шт). МойСклад берёт quantity
          // буквально и не домножает на упаковку, поэтому считаем сами.
          quantity: baseQtyOf(r),
          // Цена за одну штуку → сумма в МойСклад = цена × количество.
          priceMajor: unitPriceMajorOf(r),
        })),
      })
      const msg = `Заказ создан${doc.name ? ` № ${doc.name}` : ''}`
      setOkMsg(msg)
      // Поле могло не сохраниться, если у роли нет прав именно на него —
      // сам заказ при этом создаётся, поэтому это предупреждение, не ошибка.
      setWarn(doc.attrSkipped && kindAttr
        ? `Заказ создан, но «${kindAttr.name}» не сохранён: у роли нет прав на это доп. поле`
        : null)
      setToast(msg)          // всплывающее окно, исчезнет через 5 сек
      // Reset to an empty order
      setRows([freshRow()])
      setAgent(null)
      setContractId('')
      setStateId(defaultStateId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  /** Готовая запись attributes[] для «Вида товара» — либо ничего. */
  function kindAttribute(): Array<Record<string, unknown>> | undefined {
    if (!kindAttr) return undefined
    if (kindAttr.type === 'customentity') {
      const picked = kindValues.find(v => v.id === kindId)
      return picked ? [buildDictAttribute('customerorder', kindAttr.id, picked.meta)] : undefined
    }
    return kindText.trim()
      ? [buildTextAttribute('customerorder', kindAttr.id, kindText.trim())]
      : undefined
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-base text-fg">
      {/* Телефон: одна строка-сводка вместо всей шапки */}
      <button
        type="button"
        onClick={() => setParamsOpen(v => !v)}
        aria-expanded={paramsOpen}
        className="lg:hidden shrink-0 w-full flex items-center gap-2 px-3 h-11 border-b border-line bg-surface text-left"
      >
        <span className="flex-1 min-w-0 truncate text-xs text-muted">
          {agent ? <span className="text-fg font-medium">{agent.name}</span> : 'Параметры заказа'}
          {selectedState && <span className="text-faint"> · {selectedState.name}</span>}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${paramsOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Order header */}
      <div className={`${paramsOpen ? 'flex' : 'hidden'} lg:flex shrink-0 max-h-[55vh] lg:max-h-none overflow-y-auto lg:overflow-visible border-b border-line bg-surface px-3 py-2 flex-col lg:flex-row lg:flex-wrap lg:items-center gap-x-4 gap-y-2.5`}>
        <label className={HEAD_LABEL}>
          Юр. лицо:
          {organizations === null ? <span className="text-faint">…</span> : (
            <select value={orgId} onChange={e => setOrgId(e.target.value)} className={`${FIELD} ${HEAD_INPUT} lg:max-w-[200px]`}>
              {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </label>
        <label className={HEAD_LABEL}>
          Склад:
          {stores === null ? <span className="text-faint">…</span> : stores.length === 0 ? <span className="text-faint">нет</span> : (
            <select value={storeId} onChange={e => setStoreId(e.target.value)} className={`${FIELD} ${HEAD_INPUT} lg:max-w-[180px]`}>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </label>
        <label className={HEAD_LABEL}>
          Дата:
          <input type="date" value={date} onChange={e => setDate(e.target.value)} className={`${FIELD} ${HEAD_INPUT} font-mono`} />
        </label>
        <label className={HEAD_LABEL}>
          Контрагент:
          <div className={`${HEAD_INPUT} lg:w-52 lg:flex-none rounded-md border border-line bg-surface`}>
            <SearchCell value={agent} onSelect={setAgent} fetch={searchCounterparties} token={token} placeholder="Выберите контрагента…" />
          </div>
        </label>
        <div className={HEAD_LABEL}>
          Договор:
          {newContract === null ? (
            <>
              <select
                value={contractId}
                onChange={e => setContractId(e.target.value)}
                disabled={!agent || contracts.length === 0}
                className={`${FIELD} ${HEAD_INPUT} lg:max-w-[200px] disabled:opacity-50`}
              >
                <option value="">{!agent ? '— выберите контрагента —' : contracts.length === 0 ? '— нет договоров —' : '— не задан —'}</option>
                {contracts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => { setNewContract(''); setContractErr(null) }}
                disabled={!agent || !orgId}
                title={agent ? 'Создать договор' : 'Сначала выберите контрагента'}
                className="w-9 h-9 lg:w-7 lg:h-7 shrink-0 rounded-md border border-line flex items-center justify-center text-muted hover:text-accent hover:border-accent transition-colors disabled:opacity-40 disabled:hover:text-muted disabled:hover:border-line"
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
                className={`${FIELD} ${HEAD_INPUT} lg:w-44 ${contractDuplicate ? 'border-red-500' : ''}`}
              />
              <button
                type="button"
                onClick={handleCreateContract}
                disabled={!newContract.trim() || contractBusy || contractDuplicate}
                title={contractDuplicate ? 'Такой номер уже существует' : 'Сохранить договор'}
                className="w-9 h-9 lg:w-7 lg:h-7 shrink-0 rounded-md bg-accent text-white flex items-center justify-center hover:bg-accent-strong transition-colors disabled:opacity-40"
              >
                {contractBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
              </button>
              <button
                type="button"
                onClick={() => { setNewContract(null); setContractErr(null) }}
                title="Отмена"
                className="w-9 h-9 lg:w-7 lg:h-7 shrink-0 rounded-md border border-line flex items-center justify-center text-muted hover:text-red-500 transition-colors"
              >
                <X size={14} />
              </button>
              {contractDuplicate && <span className="text-[11px] text-red-500">Номер уже занят</span>}
              {contractErr && <span className="text-[11px] text-red-500">{contractErr}</span>}
            </>
          )}
        </div>
        {kindAttr && (
          <label className={HEAD_LABEL}>
            {kindAttr.name}:
            {kindAttr.type === 'customentity' ? (
              <select
                value={kindId}
                onChange={e => setKindId(e.target.value)}
                disabled={kindValues.length === 0}
                className={`${FIELD} ${HEAD_INPUT} lg:max-w-[190px]`}
              >
                <option value="">
                  {kindValues.length === 0 ? '— справочник пуст —' : '— не задан —'}
                </option>
                {kindValues.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            ) : (
              <input
                value={kindText}
                onChange={e => setKindText(e.target.value)}
                placeholder="не задан"
                className={`${FIELD} ${HEAD_INPUT} lg:w-44`}
              />
            )}
          </label>
        )}
        <label className={HEAD_LABEL}>
          Валюта:
          <select value={currency} onChange={e => setCurrency(e.target.value as Cur)} className={`${FIELD} ${HEAD_INPUT}`}>
            {CURRENCIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
        {currency === 'UZS' && (
          <label className={HEAD_LABEL}>
            Курс:
            <div className={`${HEAD_INPUT} lg:w-24 lg:flex-none rounded-md border border-line bg-surface`}>
              <GroupedNumberInput value={rate} onChange={setRate} placeholder="0" className={`${CELL} font-mono text-right`} />
            </div>
          </label>
        )}
        <label className={HEAD_LABEL}>
          Статус:
          <span className={`${HEAD_INPUT} relative flex items-center`}>
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
              className={`${FIELD} w-full lg:w-auto lg:max-w-[180px] ${selectedState ? 'pl-6' : ''}`}
              style={selectedState
                ? { color: selectedState.color, borderColor: selectedState.color, fontWeight: 600 }
                : undefined}
            >
              {/* Пустой вариант нужен, только когда статус по умолчанию не найден */}
              {!stateId && (
                <option value="" style={{ color: 'inherit', fontWeight: 400 }}>— не задан —</option>
              )}
              {states.map(s => (
                <option key={s.id} value={s.id} style={{ color: s.color, fontWeight: 600 }}>{s.name}</option>
              ))}
            </select>
          </span>
        </label>
        <div className="hidden lg:block flex-1" />
        {/* Кнопка неактивна — сразу говорим, чего не хватает, иначе нажатие
            выглядит как «ничего не произошло». На телефоне и то и другое живёт
            в нижней панели, чтобы не листать шапку ради отправки. */}
        {!submitting && submitBlocker && (
          <span className="hidden lg:inline text-xs text-amber-600">{submitBlocker}</span>
        )}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          title={submitBlocker ?? 'Создать заказ в МойСклад'}
          className="hidden lg:flex items-center gap-1.5 h-8 px-4 rounded-md bg-accent text-white text-xs font-semibold hover:bg-accent-strong transition-all disabled:opacity-40"
        >
          {submitting && <Loader2 size={13} className="animate-spin" />}
          {submitting ? 'Создание…' : 'Создать заказ'}
        </button>
      </div>

      {/* Телефон: каждая позиция — карточка; таблица в 8 столбцов туда не влезает */}
      <div className="lg:hidden flex-1 min-h-0 overflow-auto px-3 py-3 space-y-3">
        {rows.map((r, i) => (
          <div key={r.key} className="rounded-xl border border-line bg-surface p-3 space-y-3">
            <div className="flex items-start gap-2">
              <span className="w-5 shrink-0 pt-2.5 text-center font-mono text-xs text-faint">{i + 1}</span>
              <div className="min-w-0 flex-1 rounded-lg border border-line bg-surface focus-within:ring-2 focus-within:ring-accent focus-within:ring-inset">
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
              <button
                type="button"
                onClick={() => removeRow(r.key)}
                disabled={rows.length === 1}
                aria-label="Удалить позицию"
                className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-faint active:bg-red-500/10 active:text-red-500 disabled:opacity-30"
              >
                <Trash2 size={16} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <MField label="Количество">
                <GroupedNumberInput
                  value={r.quantity}
                  onChange={n => patchRow(r.key, { quantity: n })}
                  placeholder="0"
                  className={`${CELL} font-mono text-right`}
                />
              </MField>
              <MField label="Ед. изм.">
                <select
                  value={r.packId}
                  onChange={e => patchRow(r.key, { packId: e.target.value })}
                  disabled={!r.product}
                  className={`${CELL} disabled:cursor-not-allowed`}
                >
                  <option value="">{baseUnitLabel(r)}</option>
                  {(r.product?.packs ?? []).map(p => (
                    <option key={p.id} value={p.id}>{packLabel(r, p)}</option>
                  ))}
                </select>
              </MField>
              <MField label="Цена за литр, $">
                <GroupedNumberInput
                  value={r.pricePerLiter}
                  onChange={n => patchRow(r.key, { pricePerLiter: n })}
                  placeholder="0"
                  decimalComma
                  className={`${CELL} font-mono text-right font-bold`}
                />
              </MField>
              <MStat
                label="Остаток"
                value={r.product ? stockLabel(r.product) : '—'}
                valueClassName={r.product && r.product.stock <= 0 ? 'text-red-500 opacity-70' : 'text-muted'}
              />
            </div>

            <div className="flex items-center justify-between border-t border-line pt-2 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted">
                Объём {r.product ? `${fmtMoney(litersOf(r))} л` : '—'}
              </span>
              <span className="font-mono font-bold tabular-nums text-fg">
                {fmtMoney(sumOf(r))} {sumCurLabel}
              </span>
            </div>
          </div>
        ))}

        <button
          type="button"
          onClick={addRow}
          className="w-full h-12 flex items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-muted active:bg-surface-2"
        >
          <Plus size={16} /> Добавить товар
        </button>
      </div>

      {/* Positions grid (широкий экран) */}
      <div className="hidden lg:block flex-1 min-h-0 overflow-auto">
        <div style={{ minWidth: widths.reduce((s, w) => s + w, 0) + 84 }} className="min-h-full flex flex-col">
          {/* Header */}
          <div className="grid sticky top-0 z-20 bg-surface-2 border-b border-line shadow-sm" style={{ gridTemplateColumns: COLS }}>
            <div className={GUTTER} />
            <HeadCell label="Товар" onResizeStart={startResize(0)} />
            <HeadCell label="Количество" className="text-right" onResizeStart={startResize(1)} />
            <HeadCell label="Остаток" className="text-right" onResizeStart={startResize(2)} />
            <HeadCell label="Ед. изм." onResizeStart={startResize(3)} />
            <HeadCell label="Объём, л" className="text-right" onResizeStart={startResize(4)} />
            <HeadCell label="Цена за литр, $" className="text-right" onResizeStart={startResize(5)} />
            <HeadCell label={`Сумма, ${sumCurLabel}`} className="text-right" onResizeStart={startResize(6)} />
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

      {/* Телефон: итоги и отправка всегда под рукой */}
      <div className="lg:hidden shrink-0 border-t border-line bg-surface px-3 py-2 space-y-1.5">
        {okMsg && <p className="text-xs text-green-600">✓ {okMsg}</p>}
        {warn && <p className="text-xs text-amber-600">{warn}</p>}
        {error && <p className="text-xs text-red-600">Ошибка: {error}</p>}
        {!submitting && !error && submitBlocker && <p className="text-xs text-amber-600">{submitBlocker}</p>}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] text-muted">Позиций: {rows.length} · {fmtMoney(totalLiters)} л</p>
            <p className="truncate font-mono text-[17px] font-bold tabular-nums text-fg">
              {fmtMoney(total)} {sumCurLabel}
            </p>
          </div>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="h-12 px-4 shrink-0 flex items-center gap-2 whitespace-nowrap rounded-xl bg-accent text-white text-sm font-semibold active:bg-accent-strong disabled:opacity-40"
          >
            {submitting && <Loader2 size={15} className="animate-spin" />}
            {submitting ? 'Создание…' : 'Создать заказ'}
          </button>
        </div>
      </div>

      {/* Status bar (широкий экран) */}
      <div className="hidden lg:flex shrink-0 h-7 items-center gap-4 px-3 border-t border-line bg-surface-2 text-[11px] text-faint">
        <span>Позиций: {rows.length}</span>
        <span className="tabular-nums">
          Итого: {fmtMoney(total)} {currency === 'UZS' ? 'сум' : '$'}
          {currency === 'UZS' && rate > 0 && <> · ${fmtMoney(totalUsd)}</>}
          {' · '}Объём: {fmtMoney(totalLiters)} л
        </span>
        <button
          type="button"
          onClick={resetWidths}
          title="Вернуть исходную ширину столбцов"
          className="text-faint hover:text-accent hover:underline transition-colors"
        >
          Сбросить ширину столбцов
        </button>
        <div className="flex-1" />
        {okMsg && <span className="text-green-600">✓ {okMsg}</span>}
        {warn && <span className="text-amber-600">{warn}</span>}
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
