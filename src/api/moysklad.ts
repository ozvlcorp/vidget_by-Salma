// Requests go to /api/moysklad/* — proxied by Vite (dev) or nginx (prod).
// When the widget runs as an installed MoySklad solution this is repointed at the
// vendor backend, which swaps our session token for the account's real one.
let BASE = '/api/moysklad'

/** Routes all further API calls through the given base (e.g. the vendor backend). */
export function setApiBase(url: string) {
  BASE = url.replace(/\/+$/, '')
}
// meta.href values inside request bodies must point at the real MoySklad API
// (the platform resolves entity refs from this URL) — independent of the proxy path above.
const MS_API_ROOT = 'https://api.moysklad.ru/api/remap/1.2'

export function msDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * Document timestamp for MoySklad.
 *
 * MoySklad has no timezone in its datetime format and always reads the value as
 * Moscow time (MSK, UTC+3), then shows it back in the viewer's timezone. Sending
 * the raw local clock therefore shifts the document (e.g. Tashkent UTC+5 sees
 * "+2 hours"). So we take the chosen calendar date plus the current local
 * time-of-day and re-express that instant as Moscow wall-clock time.
 *
 * @param dateStr calendar date picked in the widget, "YYYY-MM-DD"
 */
export function msMoment(dateStr: string): string {
  const now = new Date()
  return mskAt(dateStr, now.getHours(), now.getMinutes(), now.getSeconds())
}

/** Локальные дата+время выбранного дня, выраженные как московские часы. */
export function mskAt(dateStr: string, h: number, m: number, s: number): string {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const local = new Date(y, (mo || 1) - 1, d || 1, h, m, s)
  // Same instant expressed as Moscow wall clock (read via UTC getters after +3h).
  const msk = new Date(local.getTime() + 3 * 60 * 60 * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${msk.getUTCFullYear()}-${p(msk.getUTCMonth() + 1)}-${p(msk.getUTCDate())} `
    + `${p(msk.getUTCHours())}:${p(msk.getUTCMinutes())}:${p(msk.getUTCSeconds())}`
}

// ─── Rate Limiter ──────────────────────────────────────────────────────────────

class Semaphore {
  private slots: number
  private queue: Array<() => void> = []
  constructor(max: number) { this.slots = max }
  acquire(): Promise<void> {
    if (this.slots > 0) { this.slots--; return Promise.resolve() }
    return new Promise(resolve => this.queue.push(resolve))
  }
  release() {
    const next = this.queue.shift()
    if (next) next(); else this.slots++
  }
}
// MoySklad allows 5 parallel requests per token per solution — stay below that limit
const sem = new Semaphore(4)

/** All MoySklad fetches go through this — respects semaphore + retries on 429 */
async function msFetch(url: string, init: RequestInit = {}): Promise<Response> {
  await sem.acquire()
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(url, init)
      if (r.status === 401) {
        window.dispatchEvent(new CustomEvent('ms:session-expired'))
        throw new Error('SESSION_EXPIRED')
      }
      if (r.status !== 429) return r
      await new Promise(res => setTimeout(res, 1000 * (attempt + 1)))
    }
    throw new Error('Rate limited after 3 retries')
  } finally {
    sem.release()
  }
}

async function get<T>(path: string, params: Record<string, string>, token: string): Promise<T> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&')
  const url = qs ? `${BASE}${path}?${qs}` : `${BASE}${path}`
  const r = await msFetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`${r.status}: ${text.slice(0, 200)}`)
  }
  return r.json()
}

// ─── Auth ───────────────────────────────────────────────────────────────────────

// UTF-8 → base64 (btoa alone breaks on non-Latin1 chars in a password).
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin)
}

/**
 * Exchanges a MoySklad login + password for a personal access token
 * (POST /security/token, HTTP Basic auth). The token then authorises every
 * request as that employee. We never store the password — only the token.
 */
export async function login(username: string, password: string): Promise<string> {
  let r: Response
  try {
    r = await fetch(`${BASE}/security/token`, {
      method: 'POST',
      // MoySklad требует Accept строго с charset — иначе 400 «Неверное значение заголовка 'Accept'».
      headers: { Authorization: `Basic ${b64(`${username}:${password}`)}`, Accept: 'application/json;charset=utf-8' },
    })
  } catch {
    throw new Error('Нет связи с сервером. Проверьте интернет и попробуйте снова.')
  }
  if (r.status === 401) throw new Error('Неверный логин или пароль')
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let msg = `Ошибка входа (HTTP ${r.status})`
    try {
      const p = JSON.parse(text) as { errors?: Array<{ error?: string }> }
      if (p?.errors?.[0]?.error) msg = p.errors[0].error!
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const data = await r.json() as { access_token?: string }
  if (!data.access_token) throw new Error('Сервер не вернул токен')
  return data.access_token
}

/** Display name of the currently authenticated employee ('' if unavailable). */
export async function getMyName(token: string): Promise<string> {
  return (await getMyContext(token)).name
}

/** Who is signed in and which MoySklad account they belong to. */
export async function getMyContext(token: string): Promise<{ name: string; accountId: string }> {
  type Ctx = { name?: string; fullName?: string; accountId?: string }
  const data = await get<Ctx>('/context/employee', {}, token).catch(() => ({} as Ctx))
  // fullName — «Фамилия Имя Отчество»; name часто сокращённое, поэтому предпочитаем полное.
  return { name: data.fullName || data.name || '', accountId: data.accountId ?? '' }
}

// Виджет сделан для одного клиента: пускаем только его аккаунт МойСклад.
// Список можно переопределить переменной сборки VITE_ALLOWED_ACCOUNT_IDS.
const ALLOWED_ACCOUNTS = ((import.meta.env.VITE_ALLOWED_ACCOUNT_IDS as string | undefined)
  ?? '9d53a471-8424-11f1-0a80-1b6300015433')
  .split(',').map(s => s.trim()).filter(Boolean)

/** Разрешён ли этот аккаунт. Пустой список = ограничение отключено. */
export function isAllowedAccount(accountId: string): boolean {
  return ALLOWED_ACCOUNTS.length === 0 || ALLOWED_ACCOUNTS.includes(accountId)
}

// ─── Currencies ───────────────────────────────────────────────────────────────

export interface CurrencyRate {
  id: string
  isoCode: string
  symbol: string
  name: string
  /** Base-currency units per 1 unit of this currency (e.g. 12000 for 1 USD = 12000 UZS) */
  rate: number
  isDefault: boolean
}

export async function getCurrencies(token: string): Promise<CurrencyRate[]> {
  const data = await get<{
    rows: Array<{
      id: string; isoCode: string; symbol: string; name: string
      // MoySklad uses "default" (not "isDefault") for the accounting currency flag
      default: boolean; rate: number; multiplicity: number; indirect?: boolean
    }>
  }>('/entity/currency', { limit: '50' }, token)
  return data.rows.map(c => {
    const rate = c.rate || 1, mult = c.multiplicity || 1
    // `indirect` means the stored rate is the inverse (foreign per base); normalize
    // everything to base-currency units per 1 unit of this currency.
    const basePerUnit = c.indirect ? (mult / rate) : (rate / mult)
    return {
      id: c.id,
      isoCode: c.isoCode,
      symbol: c.symbol,
      name: c.name,
      // Снимаем шум float от инверсии, но оставляем достаточно знаков: на 6
      // значащих цифрах пересчёт крупных сумм уже даёт заметную погрешность.
      rate: Number(basePerUnit.toPrecision(12)),
      isDefault: c.default ?? false,
    }
  })
}

/** Валюты, между которыми переключается пользователь. */
export type WidgetCurrency = 'UZS' | 'USD'

/** Валюта учёта аккаунта (может быть и сум, и доллар — зависит от настройки). */
export function baseCurrencyOf(currencies: CurrencyRate[]): CurrencyRate | null {
  return currencies.find(c => c.isDefault) ?? null
}

/**
 * Что положить в блок `rate` документа для выбранной валюты.
 *
 * МойСклад ведёт документ в валюте учёта, пока не указана другая, и отклоняет
 * курс, заданный для самой валюты учёта. Какая из сум/доллар является валютой
 * учёта — зависит от аккаунта, поэтому определяем это по справочнику, а не
 * предполагаем заранее.
 *
 * @param uzsPerUsd курс, введённый пользователем (сум за 1 доллар); 0 — не задан
 */
export function resolveDocCurrency(
  currencies: CurrencyRate[], picked: WidgetCurrency, uzsPerUsd: number,
): { currencyId?: string; rateValue?: number } {
  const base = baseCurrencyOf(currencies)
  const target = currencies.find(c => c.isoCode === picked) ?? null
  // Документ в валюте учёта → блок валюты/курса не нужен вовсе.
  if (!target || base?.isoCode === picked) return {}
  // rate.value = единиц валюты учёта за 1 единицу валюты документа.
  let rateValue: number | undefined
  if (base?.isoCode === 'UZS' && picked === 'USD') rateValue = uzsPerUsd > 0 ? uzsPerUsd : undefined
  else if (base?.isoCode === 'USD' && picked === 'UZS') rateValue = uzsPerUsd > 0 ? 1 / uzsPerUsd : undefined
  // Курса от пользователя нет — пусть МойСклад подставит свой текущий курс.
  return { currencyId: target.id, ...(rateValue ? { rateValue } : {}) }
}

// ─── Payment split widget: legal entities, counterparty search, document creation ──

function msRef(type: string, id: string) {
  return { meta: { href: `${MS_API_ROOT}/entity/${type}/${id}`, type, mediaType: 'application/json' } }
}

export interface OrganizationOption { id: string; name: string }

/** Legal entities (юр. лица) for the organization dropdown — excludes archived ones. */
export async function getOrganizations(token: string): Promise<OrganizationOption[]> {
  const data = await get<{ rows: Array<{ id: string; name: string; archived?: boolean }> }>(
    '/entity/organization', { limit: '100' }, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string; archived?: boolean }> }))
  return data.rows.filter(o => !o.archived).map(o => ({ id: o.id, name: o.name }))
}

/** A generic {id, name} option used by the table's searchable dropdowns. */
export interface NamedOption { id: string; name: string }

export interface CounterpartyOption { id: string; name: string }

/**
 * Counterparty list for the split-row autocomplete. With a query it searches
 * by name/phone/INN; with an empty query it returns the first counterparties
 * (name order) so a list shows as soon as the field is focused.
 */
export async function searchCounterparties(token: string, query: string): Promise<CounterpartyOption[]> {
  const q = query.trim()
  const params: Record<string, string> = q
    ? { search: q, limit: '20' }
    : { limit: '20', order: 'name,asc' }
  const data = await get<{ rows: Array<{ id: string; name: string; archived?: boolean }> }>(
    '/entity/counterparty', params, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string; archived?: boolean }> }))
  return data.rows.filter(c => !c.archived).map(c => ({ id: c.id, name: c.name }))
}

// ─── Customer order (Заказ покупателя) ────────────────────────────────────────

export interface StoreOption { id: string; name: string }

/** Warehouses (склады) for the store dropdown. */
export async function getStores(token: string): Promise<StoreOption[]> {
  const data = await get<{ rows: Array<{ id: string; name: string; archived?: boolean }> }>(
    '/entity/store', { limit: '100' }, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string; archived?: boolean }> }))
  return data.rows.filter(s => !s.archived).map(s => ({ id: s.id, name: s.name }))
}

/** Units of measure (единицы измерения) — id → name, to label шт / коробка etc. */
export async function getUoms(token: string): Promise<NamedOption[]> {
  const data = await get<{ rows: Array<{ id: string; name: string }> }>(
    '/entity/uom', { limit: '1000' }, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string }> }))
  return (data.rows ?? []).map(u => ({ id: u.id, name: u.name }))
}

const idFromHref = (href?: string): string | null => href ? (href.split('/').pop() ?? null) : null

/** A packaging (упаковка) of a product: how many base units it holds, and its own uom. */
export interface ProductPack {
  id: string
  quantity: number                      // base units per pack
  uomId: string | null
  uomMeta: Record<string, unknown> | null
}

/** A product/variant/service from the assortment, with price-per-liter, volume and packs. */
export interface ProductOption {
  id: string
  name: string
  type: string
  salePrice: number                     // minor units, per base uom
  pricePerLiter: number                 // «Цена за литр (доллар)» — доп. поле, в долларах
  volume: number                        // объём из карточки товара (per base unit)
  uomId: string | null                  // base unit of measure
  stock: number                         // остаток (доступно) в базовых единицах
  packs: ProductPack[]
}

/**
 * Assortment search for order positions. Returns products/variants/services with
 * their volume, base uom, packaging, and the "Цена за литр (доллар)" custom field.
 */
export async function searchProducts(token: string, query: string, storeId?: string): Promise<ProductOption[]> {
  const q = query.trim()
  // No query → no suggestions (the dropdown only opens once the user types).
  if (!q) return []
  const params: Record<string, string> = { search: q, limit: '20' }
  // Scope the stock/quantity fields to a single store when one is chosen;
  // without it MoySklad returns aggregate stock across all stores.
  if (storeId) params.filter = `stockStore=${MS_API_ROOT}/entity/store/${storeId}`
  type Row = {
    id: string; name: string; meta: { type: string }
    salePrices?: Array<{ value: number }>
    volume?: number
    stock?: number
    quantity?: number
    uom?: { meta?: { href?: string } }
    packs?: Array<{ id: string; quantity?: number; uom?: { meta?: { href?: string } & Record<string, unknown> } }>
    attributes?: Array<{ name?: string; value?: unknown }>
  }
  const data = await get<{ rows: Row[] }>('/entity/assortment', params, token)
    .catch(() => ({ rows: [] as Row[] }))
  const readPricePerLiter = (attrs?: Array<{ name?: string; value?: unknown }>): number => {
    const a = attrs?.find(x => /цена\s*за\s*литр/i.test(x.name ?? ''))
    // custom field value can be a plain number or an object { value } depending on type
    const raw = a?.value
    const v = typeof raw === 'object' && raw !== null ? Number((raw as { value?: unknown }).value) : Number(raw)
    return isFinite(v) ? v : 0
  }
  // MoySklad `search` also matches code/article/description; keep only rows whose
  // *name* contains the typed text, so the list shows exactly what the user typed.
  const ql = q.toLowerCase()
  return (data.rows ?? []).filter(r => (r.name ?? '').toLowerCase().includes(ql)).map(r => ({
    id: r.id,
    name: r.name,
    type: r.meta?.type ?? 'product',
    salePrice: r.salePrices?.[0]?.value ?? 0,
    pricePerLiter: readPricePerLiter(r.attributes),
    volume: r.volume ?? 0,
    uomId: idFromHref(r.uom?.meta?.href),
    // assortment rows expose available stock in `stock` (services/variants may lack it)
    stock: r.stock ?? r.quantity ?? 0,
    packs: (r.packs ?? []).map(p => ({
      id: p.id,
      quantity: p.quantity ?? 1,
      uomId: idFromHref(p.uom?.meta?.href),
      uomMeta: p.uom?.meta ?? null,
    })),
  }))
}

/** A configurable order state (Статус) from the customerorder metadata. */
export interface OrderState {
  id: string
  name: string
  meta: Record<string, unknown>
  /** CSS colour of the status, same as shown in MoySklad (e.g. "#4caf50"). */
  color: string
}

/**
 * MoySklad stores a state's colour as a signed 32-bit integer (0xAARRGGBB).
 * Keep the low 24 bits (RGB) and render as CSS hex.
 */
function stateColor(raw?: number): string {
  if (typeof raw !== 'number' || !isFinite(raw)) return '#9e9e9e'
  const rgb = (raw >>> 0) & 0xffffff
  return `#${rgb.toString(16).padStart(6, '0')}`
}

/** Available statuses (состояния) for a customer order, with their MoySklad colours. */
export async function getOrderStates(token: string): Promise<OrderState[]> {
  type S = { id: string; name: string; meta: Record<string, unknown>; color?: number }
  const data = await get<{ states?: S[] }>('/entity/customerorder/metadata', {}, token)
    .catch(() => ({ states: [] as S[] }))
  return (data.states ?? []).map(s => ({ id: s.id, name: s.name, meta: s.meta, color: stateColor(s.color) }))
}

/**
 * Contracts (договоры) for the order header. Filtered by counterparty (agent) and,
 * when given, by legal entity (ownAgent). Returns [] when none match.
 */
export async function getContracts(token: string, agentId?: string, orgId?: string): Promise<NamedOption[]> {
  const filters: string[] = []
  if (agentId) filters.push(`agent=${MS_API_ROOT}/entity/counterparty/${agentId}`)
  if (orgId) filters.push(`ownAgent=${MS_API_ROOT}/entity/organization/${orgId}`)
  const params: Record<string, string> = { limit: '100' }
  if (filters.length) params.filter = filters.join(';')
  const data = await get<{ rows?: Array<{ id: string; name: string }> }>(
    '/entity/contract', params, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string }> }))
  return (data.rows ?? []).map(c => ({ id: c.id, name: c.name }))
}

/**
 * All contract numbers already in MoySklad (across counterparties) — used to warn
 * about a duplicate number before creating a new contract.
 */
export async function getAllContractNames(token: string): Promise<string[]> {
  const data = await get<{ rows?: Array<{ name: string }> }>('/entity/contract', { limit: '1000' }, token)
    .catch(() => ({ rows: [] as Array<{ name: string }> }))
  return (data.rows ?? []).map(c => c.name)
}

/** Creates a contract (договор) for a counterparty + legal entity. */
export async function createContract(
  token: string, p: { name: string; agentId: string; orgId: string }
): Promise<NamedOption> {
  const body = {
    name: p.name,
    agent: msRef('counterparty', p.agentId),
    ownAgent: msRef('organization', p.orgId),
    contractType: 'Sales',
  }
  const r = await msFetch(`${BASE}/entity/contract`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json;charset=utf-8',
    },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let msg = `HTTP ${r.status}`
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ error?: string }> }
      if (parsed?.errors?.[0]?.error) msg = parsed.errors[0].error!
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const data = await r.json() as { id: string; name: string }
  return { id: data.id, name: data.name }
}

// ─── Мини-дашборд продаж ──────────────────────────────────────────────────────

/** Одна отгруженная позиция заказа, приведённая к литрам и коробкам. */
export interface SalesOrder {
  id: string
  name: string
  moment: string
  agentName: string
  /** Кто оформил: из комментария «Оформил: …», иначе владелец документа. */
  employee: string
  liters: number
  boxes: number
  /** Сумма в валюте самого документа. */
  sumMajor: number
  /** Та же сумма в валюте учёта — по ней сравниваем заказы в разных валютах. */
  baseSumMajor: number
}

/**
 * Заказы покупателей за период, посчитанные в литрах и коробках.
 *
 * Литраж = объём товара × количество (в документе количество в базовых единицах).
 * Коробки = количество ÷ размер упаковки из карточки товара.
 */
export async function getSalesOrders(token: string, fromDate: string, toDate: string): Promise<SalesOrder[]> {
  type Pos = {
    quantity?: number
    price?: number
    assortment?: { volume?: number; packs?: Array<{ quantity?: number }> }
  }
  type Row = {
    id: string; name?: string; moment?: string; sum?: number; description?: string
    /** Есть, только когда документ не в валюте учёта: value = единиц учёта за 1 единицу валюты документа. */
    rate?: { value?: number }
    agent?: { name?: string }
    owner?: { name?: string; fullName?: string }
    positions?: { rows?: Pos[] }
  }
  const filter = `moment>=${mskAt(fromDate, 0, 0, 0)};moment<=${mskAt(toDate, 23, 59, 59)}`
  const out: SalesOrder[] = []
  const limit = 100
  for (let offset = 0; offset < 1000; offset += limit) {
    const data = await get<{ rows?: Row[] }>('/entity/customerorder', {
      filter,
      expand: 'agent,owner,positions.assortment',
      limit: String(limit),
      offset: String(offset),
      order: 'moment,desc',
    }, token).catch(() => ({ rows: [] as Row[] }))
    const rows = data.rows ?? []
    for (const r of rows) {
      let liters = 0, boxes = 0
      for (const p of r.positions?.rows ?? []) {
        const qty = p.quantity ?? 0
        const volume = p.assortment?.volume ?? 0
        const packSize = p.assortment?.packs?.[0]?.quantity ?? 0
        liters += volume * qty
        if (packSize > 0) boxes += qty / packSize
      }
      // «Оформил: ФИО» — наш штамп; если его нет, берём владельца документа.
      const stamped = /оформил:\s*(.+)/i.exec(r.description ?? '')?.[1]?.trim()
      out.push({
        id: r.id,
        name: r.name ?? '',
        moment: r.moment ?? '',
        agentName: r.agent?.name ?? '—',
        employee: stamped || r.owner?.fullName || r.owner?.name || '—',
        liters,
        boxes,
        sumMajor: (r.sum ?? 0) / 100,
        // Без блока rate документ уже в валюте учёта, поэтому множитель 1.
        baseSumMajor: ((r.sum ?? 0) / 100) * (r.rate?.value && r.rate.value > 0 ? r.rate.value : 1),
      })
    }
    if (rows.length < limit) break
  }
  return out
}

export interface OrderPositionInput {
  assortmentId: string
  assortmentType: string   // 'product' | 'variant' | 'service' | ...
  quantity: number         // in packs when `pack` is set, otherwise in base units
  priceMajor: number       // price per unit (per pack when `pack` set), in major units
  pack?: Record<string, unknown>  // упаковка: { id, quantity, uom } — omit for base unit
}

/**
 * Builds the `pack` payload for a position. The uom reference is rebuilt from the
 * pack's uom id rather than passed through, because the assortment listing does
 * not always carry a complete `uom.meta` — and MoySklad silently drops a pack
 * whose uom it cannot resolve (the position then falls back to base units).
 */
export function buildPackPayload(
  pack: { id: string; quantity: number; uomId: string | null; uomMeta: Record<string, unknown> | null }
): Record<string, unknown> {
  const uom = pack.uomId ? msRef('uom', pack.uomId) : (pack.uomMeta ? { meta: pack.uomMeta } : null)
  return { id: pack.id, quantity: pack.quantity, ...(uom ? { uom } : {}) }
}

/** A position as MoySklad stored it — used to verify packs were actually applied. */
export interface StoredPosition {
  id: string
  quantity: number
  /** Present only when MoySklad accepted the упаковка on that position. */
  hasPack: boolean
  assortmentId: string | null
}

/** Reads back the positions of a created order, in document order. */
export async function getOrderPositions(token: string, orderId: string): Promise<StoredPosition[]> {
  type Row = {
    id: string; quantity: number
    pack?: { id?: string } | null
    assortment?: { meta?: { href?: string } }
  }
  const data = await get<{ rows?: Row[] }>(`/entity/customerorder/${orderId}/positions`, { limit: '1000' }, token)
    .catch(() => ({ rows: [] as Row[] }))
  return (data.rows ?? []).map(r => ({
    id: r.id,
    quantity: r.quantity,
    hasPack: !!r.pack,
    assortmentId: idFromHref(r.assortment?.meta?.href),
  }))
}

/** Corrects a stored position's quantity/price (used when упаковка wasn't applied). */
export async function updateOrderPosition(
  token: string, orderId: string, positionId: string, p: { quantity: number; priceMajor: number }
): Promise<void> {
  const r = await msFetch(`${BASE}/entity/customerorder/${orderId}/positions/${positionId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json;charset=utf-8',
    },
    body: JSON.stringify({
      quantity: p.quantity,
      price: Math.round(p.priceMajor * 100 * 100) / 100,
    }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let msg = `HTTP ${r.status}`
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ error?: string }> }
      if (parsed?.errors?.[0]?.error) msg = parsed.errors[0].error!
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
}

export interface CreateOrderParams {
  organizationId: string
  agentId: string
  storeId?: string
  moment?: string          // "YYYY-MM-DD HH:MM:SS"
  currencyId?: string      // omit → base currency
  rateValue?: number       // base per 1 unit of currencyId
  stateMeta?: Record<string, unknown>  // chosen status meta
  contractId?: string      // договор (optional)
  /** Комментарий к документу — сюда пишем ФИО сотрудника, оформившего его. */
  description?: string
  positions: OrderPositionInput[]
}

/** Creates a customer order (заказ покупателя) with its positions. */
export async function createCustomerOrder(token: string, p: CreateOrderParams): Promise<CreatedDoc> {
  const body: Record<string, unknown> = {
    organization: msRef('organization', p.organizationId),
    agent: msRef('counterparty', p.agentId),
    positions: p.positions.map(pos => {
      const position: Record<string, unknown> = {
        quantity: pos.quantity,
        // Цену не округляем сами до целых копеек — передаём как есть (до сотых копейки,
        // чтобы убрать только шум float). Если у аккаунта включена повышенная точность
        // цен, МойСклад сохранит дробную часть; иначе округлит на своей стороне.
        price: Math.round(pos.priceMajor * 100 * 100) / 100,
        assortment: msRef(pos.assortmentType, pos.assortmentId),
      }
      if (pos.pack) position.pack = pos.pack
      return position
    }),
  }
  if (p.storeId) body.store = msRef('store', p.storeId)
  if (p.moment) body.moment = p.moment
  if (p.contractId) body.contract = msRef('contract', p.contractId)
  if (p.description) body.description = p.description
  if (p.stateMeta) body.state = { meta: p.stateMeta }
  if (p.currencyId) {
    body.rate = p.rateValue != null && p.rateValue > 0
      ? { currency: msRef('currency', p.currencyId), value: p.rateValue }
      : { currency: msRef('currency', p.currencyId) }
  }

  const r = await msFetch(`${BASE}/entity/customerorder`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let msg = `HTTP ${r.status}`
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ error?: string }> }
      if (parsed?.errors?.[0]?.error) msg = parsed.errors[0].error!
    } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const data = await r.json() as { id: string; name?: string; meta?: { uuidHref?: string } }
  return { id: data.id, name: data.name ?? null, uuidHref: data.meta?.uuidHref ?? null }
}

export type PaymentDocType = 'cashin' | 'paymentin'

/** A custom attribute (доп. поле) defined on a document type's metadata. */
export interface DocAttribute {
  id: string
  name: string
  type: string
  /** For type === 'customentity' — meta.href of the dictionary (справочник) */
  customEntityHref: string | null
}

/**
 * Custom attributes (доп. поля) declared for a cashin/paymentin document type.
 * Used to locate the "От кого" field so its value can be written on creation.
 */
export async function getDocAttributes(token: string, type: PaymentDocType): Promise<DocAttribute[]> {
  const data = await get<{ rows: Array<{ id: string; name: string; type: string; customEntityMeta?: { href?: string } }> }>(
    `/entity/${type}/metadata/attributes`, {}, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string; type: string; customEntityMeta?: { href?: string } }> }))
  return (data.rows ?? []).map(a => ({
    id: a.id, name: a.name, type: a.type, customEntityHref: a.customEntityMeta?.href ?? null,
  }))
}

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g

/**
 * Searches the values of the "От кого" справочник (customentity dictionary) so the
 * Фирма column can suggest existing companies. Returns [] when the field isn't a
 * dictionary or the dictionary can't be resolved (the column then stays free-text).
 */
export async function searchFromWhomValues(token: string, attr: DocAttribute | null, query: string): Promise<NamedOption[]> {
  if (!attr || attr.type !== 'customentity' || !attr.customEntityHref) return []
  const dictId = attr.customEntityHref.match(UUID_RE)?.pop()
  if (!dictId) return []
  const q = query.trim()
  const params: Record<string, string> = q ? { search: q, limit: '20' } : { limit: '20' }
  const data = await get<{ rows?: Array<{ id: string; name: string }> }>(
    `/entity/customentity/${dictId}`, params, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string }> }))
  return (data.rows ?? []).map(r => ({ id: r.id, name: r.name }))
}

/** Finds a dictionary (справочник) element by exact name, creating it if absent. Returns its meta. */
async function findOrCreateCustomEntity(
  token: string, dictHref: string | null, name: string
): Promise<Record<string, unknown>> {
  // The dictionary id is a UUID in the customEntityMeta href — take the last one,
  // regardless of the exact path shape MoySklad uses.
  const dictId = dictHref?.match(UUID_RE)?.pop()
  if (!dictId) throw new Error(`Не удалось определить справочник для поля «От кого» (ссылка: ${dictHref ?? 'отсутствует'})`)
  const init: RequestInit = { headers: { Authorization: `Bearer ${token}` } }

  const sr = await msFetch(`${BASE}/entity/customentity/${dictId}?search=${encodeURIComponent(name)}&limit=20`, init)
  if (sr.ok) {
    const d = await sr.json() as { rows?: Array<{ name?: string; meta?: Record<string, unknown> }> }
    const hit = (d.rows ?? []).find(r => (r.name ?? '').toLowerCase() === name.toLowerCase())
    if (hit?.meta) return hit.meta
  }

  const cr = await msFetch(`${BASE}/entity/customentity/${dictId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  if (!cr.ok) {
    const text = await cr.text().catch(() => '')
    throw new Error(`Не удалось создать значение справочника «${name}»: ${text.slice(0, 120)}`)
  }
  const created = await cr.json() as { meta?: Record<string, unknown> }
  if (!created.meta) throw new Error('Справочник вернул элемент без meta')
  return created.meta
}

/**
 * Builds the `attributes[]` entry for the "От кого" доп. поле, matching its type:
 * text/string/link → plain string value; customentity (справочник) → find-or-create
 * a dictionary element and reference it. Other object types are unsupported.
 */
export async function buildFromWhomAttribute(
  token: string, type: PaymentDocType, attr: DocAttribute, text: string
): Promise<Record<string, unknown>> {
  const meta = {
    href: `${MS_API_ROOT}/entity/${type}/metadata/attributes/${attr.id}`,
    type: 'attributemetadata',
    mediaType: 'application/json',
  }
  if (attr.type === 'string' || attr.type === 'text' || attr.type === 'link') {
    return { meta, value: text }
  }
  if (attr.type === 'customentity') {
    // The list metadata sometimes omits customEntityMeta — fetch the single
    // attribute's metadata as a fallback to get the dictionary href.
    let href = attr.customEntityHref
    if (!href) {
      const one = await get<{ customEntityMeta?: { href?: string } }>(
        `/entity/${type}/metadata/attributes/${attr.id}`, {}, token
      ).catch(() => null)
      href = one?.customEntityMeta?.href ?? null
    }
    const elMeta = await findOrCreateCustomEntity(token, href, text)
    return { meta, value: { meta: elMeta } }
  }
  throw new Error(`Тип доп. поля «${attr.name}» (${attr.type}) не поддерживается — сделайте его текстовым`)
}

export interface CreatePaymentDocParams {
  type: PaymentDocType
  organizationId: string
  agentId: string
  /** Amount in the document's own currency, major units (e.g. сум, not tiyin) */
  sumMajor: number
  /** Omit when using the account's default (base) currency */
  currencyId?: string
  /**
   * Manual rate override (base-currency units per 1 unit of currencyId).
   * Omit to let MoySklad apply the current rate from the currency directory.
   */
  rateValue?: number
  /** Комментарий к документу — сюда пишем ФИО сотрудника, оформившего его. */
  description?: string
  paymentPurpose?: string
  /** "YYYY-MM-DD HH:MM:SS" — omitted means MoySklad stamps "now" */
  moment?: string
  /** Ready-built `attributes[]` entries (e.g. from buildFromWhomAttribute) */
  attributes?: Array<Record<string, unknown>>
}

export interface CreatedDoc { id: string; name: string | null; uuidHref: string | null }

/** Creates one cashin (приходный ордер) or paymentin (входящий платёж) document. */
export async function createPaymentDocument(token: string, p: CreatePaymentDocParams): Promise<CreatedDoc> {
  const body: Record<string, unknown> = {
    organization: msRef('organization', p.organizationId),
    agent: msRef('counterparty', p.agentId),
    sum: Math.round(p.sumMajor * 100),
  }
  if (p.moment) body.moment = p.moment
  if (p.description) body.description = p.description
  if (p.paymentPurpose) body.paymentPurpose = p.paymentPurpose
  if (p.currencyId) {
    // With a value → manual override; without → MoySklad uses the current directory rate.
    body.rate = p.rateValue != null && p.rateValue > 0
      ? { currency: msRef('currency', p.currencyId), value: p.rateValue }
      : { currency: msRef('currency', p.currencyId) }
  }
  if (p.attributes && p.attributes.length) {
    body.attributes = p.attributes
  }

  const r = await msFetch(`${BASE}/entity/${p.type}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    let msg = `HTTP ${r.status}`
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ error?: string }> }
      if (parsed?.errors?.[0]?.error) msg = parsed.errors[0].error!
    } catch { /* not JSON — fall through to status code message */ }
    throw new Error(msg)
  }
  const data = await r.json() as { id: string; name?: string; meta?: { uuidHref?: string } }
  return { id: data.id, name: data.name ?? null, uuidHref: data.meta?.uuidHref ?? null }
}
