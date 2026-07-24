// Requests go to /api/moysklad/* — proxied by Vite (dev) or nginx (prod)
const BASE = '/api/moysklad'
// meta.href values inside request bodies must point at the real MoySklad API
// (the platform resolves entity refs from this URL) — independent of the proxy path above.
const MS_API_ROOT = 'https://api.moysklad.ru/api/remap/1.2'

export function msDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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
      // Round off floating-point noise from the inversion (used for display/override only)
      rate: Number(basePerUnit.toPrecision(6)),
      isDefault: c.default ?? false,
    }
  })
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
