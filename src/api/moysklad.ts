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
  /** Base-currency units per 1 unit of this currency (rate / multiplicity) */
  rate: number
  isDefault: boolean
}

export async function getCurrencies(token: string): Promise<CurrencyRate[]> {
  const data = await get<{
    rows: Array<{
      id: string; isoCode: string; symbol: string; name: string
      // MoySklad uses "default" (not "isDefault") for the accounting currency flag
      default: boolean; rate: number; multiplicity: number
    }>
  }>('/entity/currency', { limit: '50' }, token)
  return data.rows.map(c => ({
    id: c.id,
    isoCode: c.isoCode,
    symbol: c.symbol,
    name: c.name,
    rate: (c.rate || 1) / (c.multiplicity || 1),
    isDefault: c.default ?? false,
  }))
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

export interface CounterpartyOption { id: string; name: string }

/** Live counterparty search (by name/phone/INN) for the split-row autocomplete. */
export async function searchCounterparties(token: string, query: string): Promise<CounterpartyOption[]> {
  const q = query.trim()
  if (!q) return []
  const data = await get<{ rows: Array<{ id: string; name: string; archived?: boolean }> }>(
    '/entity/counterparty', { search: q, limit: '20' }, token
  ).catch(() => ({ rows: [] as Array<{ id: string; name: string; archived?: boolean }> }))
  return data.rows.filter(c => !c.archived).map(c => ({ id: c.id, name: c.name }))
}

export type PaymentDocType = 'cashin' | 'paymentin'

export interface CreatePaymentDocParams {
  type: PaymentDocType
  organizationId: string
  agentId: string
  /** Amount in the document's own currency, major units (e.g. сум, not tiyin) */
  sumMajor: number
  /** Omit both when using the account's default (base) currency */
  currencyId?: string
  /** Base-currency units per 1 unit of currencyId — from CurrencyRate.rate */
  currencyRate?: number
  paymentPurpose?: string
  /** "YYYY-MM-DD HH:MM:SS" — omitted means MoySklad stamps "now" */
  moment?: string
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
  if (p.currencyId && p.currencyRate) {
    body.rate = { currency: msRef('currency', p.currencyId), value: p.currencyRate }
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
