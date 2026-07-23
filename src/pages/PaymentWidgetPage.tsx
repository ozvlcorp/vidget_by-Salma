import { useState, useEffect, useRef, useMemo } from 'react'
import type { ChangeEvent } from 'react'
import { Plus, Trash2, ExternalLink, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import {
  getOrganizations, getCurrencies, searchCounterparties, createPaymentDocument, getDocAttributes, msDate,
  type OrganizationOption, type CounterpartyOption, type PaymentDocType,
} from '../api/moysklad'
import { useAppContext } from '../context/AppContext'
import { t } from '../i18n'
import type { Lang } from '../i18n'
import { LangSwitcher } from '../components/LangSwitcher'
import { ThemeToggle } from '../components/ThemeToggle'
import { GroupedNumberInput } from '../components/GroupedNumberInput'
import { Skeleton } from '../components/Skeleton'

interface SplitRow {
  key: string
  agent: CounterpartyOption | null
  amount: number
}

type RowResult = { status: 'success' | 'error'; message?: string; link?: string | null }

const INPUT_CLS = 'w-full px-3 py-2 text-sm rounded-lg border border-line focus:outline-none focus:border-accent text-fg placeholder-faint bg-surface/60'

// ─── Counterparty autocomplete — module-level to avoid the remount-on-render bug ──
function CounterpartyCombobox({
  token, selected, onSelect, lang,
}: {
  token: string
  selected: CounterpartyOption | null
  onSelect: (opt: CounterpartyOption | null) => void
  lang: Lang
}) {
  const [query, setQuery] = useState(selected?.name ?? '')
  const [suggestions, setSuggestions] = useState<CounterpartyOption[]>([])
  const [open, setOpen] = useState(false)
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  function handleInput(v: string) {
    setQuery(v)
    onSelect(null)
    setOpen(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!v.trim()) { setSuggestions([]); setSearching(false); return }
    setSearching(true)
    debounceRef.current = setTimeout(() => {
      searchCounterparties(token, v)
        .then(setSuggestions)
        .finally(() => setSearching(false))
    }, 300)
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={(e: ChangeEvent<HTMLInputElement>) => handleInput(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={t(lang, 'pwSearchCounterparty')}
        className={INPUT_CLS}
      />
      {open && query.trim() && (
        <div className="absolute z-30 mt-1 w-full max-h-56 overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
          {searching ? (
            <div className="px-3 py-2 text-xs text-muted">{t(lang, 'loading')}</div>
          ) : suggestions.length === 0 ? (
            <div className="px-3 py-2 text-xs text-faint">{t(lang, 'pwNoCounterpartyResults')}</div>
          ) : suggestions.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => { onSelect(s); setQuery(s.name); setOpen(false) }}
              className="w-full text-left px-3 py-2 text-sm text-fg hover:bg-surface-2 transition-colors"
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function PaymentWidgetPage() {
  const { token, lang, currencies, setCurrencies } = useAppContext()

  const [organizations, setOrganizations] = useState<OrganizationOption[] | null>(null)
  const [orgId, setOrgId] = useState('')
  const [docType, setDocType] = useState<PaymentDocType>('cashin')
  const [totalAmount, setTotalAmount] = useState(0)
  const [currencyIso, setCurrencyIso] = useState('')
  const [paymentPurpose, setPaymentPurpose] = useState('')
  const [fromWhom, setFromWhom] = useState('')

  // "От кого" custom attribute id for the currently selected doc type (null if the field isn't defined there)
  const [fromWhomAttrId, setFromWhomAttrId] = useState<string | null>(null)

  const nextKey = useRef(1)
  const [rows, setRows] = useState<SplitRow[]>([{ key: 'row-0', agent: null, amount: 0 }])

  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<Record<string, RowResult>>({})

  useEffect(() => {
    getOrganizations(token).then(setOrganizations).catch(() => setOrganizations([]))
    if (currencies.length === 0) getCurrencies(token).then(setCurrencies).catch(() => {})
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // Resolve the "От кого" доп. поле for the chosen document type (id differs per type)
  useEffect(() => {
    let cancelled = false
    getDocAttributes(token, docType)
      .then(attrs => {
        if (cancelled) return
        const found = attrs.find(a => /от\s*кого/i.test(a.name))
        setFromWhomAttrId(found?.id ?? null)
      })
      .catch(() => { if (!cancelled) setFromWhomAttrId(null) })
    return () => { cancelled = true }
  }, [token, docType])

  useEffect(() => {
    if (organizations && organizations.length > 0 && !orgId) setOrgId(organizations[0].id)
  }, [organizations, orgId])

  useEffect(() => {
    if (currencies.length > 0 && !currencyIso) {
      setCurrencyIso((currencies.find(c => c.isDefault) ?? currencies[0]).isoCode)
    }
  }, [currencies, currencyIso])

  function addRow() {
    setRows(rs => [...rs, { key: `row-${nextKey.current++}`, agent: null, amount: 0 }])
  }
  function removeRow(key: string) {
    setRows(rs => (rs.length > 1 ? rs.filter(r => r.key !== key) : rs))
    setResults(rs => {
      if (!(key in rs)) return rs
      const next = { ...rs }
      delete next[key]
      return next
    })
  }
  function patchRow(key: string, patch: Partial<SplitRow>) {
    setRows(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))
  }

  const distributed = useMemo(() => rows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0), [rows])
  const remaining = totalAmount - distributed
  const validRows = useMemo(() => rows.filter(r => r.agent && r.amount > 0), [rows])

  const selectedCurrency = currencies.find(c => c.isoCode === currencyIso)
  const canSubmit = !submitting && !!orgId && validRows.length > 0

  async function handleSubmit() {
    setSubmitting(true)
    setResults({})
    const momentStr = msDate(new Date())

    // Re-read currencies so the exchange rate is the current one from the directory,
    // not a value cached at page load.
    const freshCurrencies = await getCurrencies(token).catch(() => currencies)
    setCurrencies(freshCurrencies)
    const cur = freshCurrencies.find(c => c.isoCode === currencyIso) ?? selectedCurrency
    const isDefault = !cur || cur.isDefault

    const fromWhomTrim = fromWhom.trim()

    await Promise.all(validRows.map(async row => {
      try {
        const doc = await createPaymentDocument(token, {
          type: docType,
          organizationId: orgId,
          agentId: row.agent!.id,
          sumMajor: row.amount,
          currencyId: isDefault ? undefined : cur!.id,
          currencyRate: isDefault ? undefined : cur!.rate,
          paymentPurpose: paymentPurpose.trim() || undefined,
          moment: momentStr,
          fromWhom: fromWhomTrim || undefined,
          fromWhomAttrId: fromWhomAttrId ?? undefined,
        })
        setResults(prev => ({ ...prev, [row.key]: { status: 'success', link: doc.uuidHref } }))
      } catch (e) {
        setResults(prev => ({ ...prev, [row.key]: { status: 'error', message: e instanceof Error ? e.message : String(e) } }))
      }
    }))
    setSubmitting(false)
  }

  return (
    <div className="fabric-bg min-h-screen">
      <header className="sticky top-0 z-20 bg-surface/70 backdrop-blur-md border-b border-line">
        <div className="px-6 h-16 flex items-center gap-4">
          <span className="m3-title-large text-fg">{t(lang, 'pwTitle')}</span>
          <div className="flex-1" />
          <LangSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="px-6 py-7 space-y-6 max-w-4xl mx-auto">

        {/* ── Amount & currency ── */}
        <section className="bg-surface/75 backdrop-blur-sm rounded-xl border border-line card-shadow p-6 space-y-4">
          <h2 className="text-base font-semibold text-fg">{t(lang, 'pwAmountSection')}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5 block">{t(lang, 'pwTotalAmount')}</label>
              <GroupedNumberInput
                value={totalAmount}
                onChange={setTotalAmount}
                placeholder="30 000 000"
                className={`${INPUT_CLS} font-mono text-lg`}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5 block">{t(lang, 'pwCurrency')}</label>
              <select value={currencyIso} onChange={e => setCurrencyIso(e.target.value)} className={INPUT_CLS}>
                {currencies.map(c => (
                  <option key={c.isoCode} value={c.isoCode}>{c.isoCode} {c.isDefault ? '★' : ''}</option>
                ))}
              </select>
            </div>
          </div>

          {/* «От кого» — источник денег, до распределения (доп. поле документа) */}
          <div>
            <label className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5 block">{t(lang, 'pwFromWhom')}</label>
            <input
              type="text"
              value={fromWhom}
              onChange={e => setFromWhom(e.target.value)}
              placeholder={t(lang, 'pwFromWhomPlaceholder')}
              className={INPUT_CLS}
            />
            {fromWhom.trim() && fromWhomAttrId === null && (
              <p className="text-xs text-amber-600 mt-1">{t(lang, 'pwFromWhomMissing')}</p>
            )}
          </div>
        </section>

        {/* ── Counterparties ── */}
        <section className="bg-surface/75 backdrop-blur-sm rounded-xl border border-line card-shadow p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-fg">{t(lang, 'pwCounterpartiesSection')}</h2>
            <div className="text-sm">
              <span className="text-muted">{t(lang, 'pwDistributed')}: </span>
              <span className="font-mono font-semibold text-fg">
                {distributed.toLocaleString('ru-RU')} {currencyIso}
              </span>
            </div>
          </div>

          <div className="space-y-3">
            {rows.map(row => {
              const result = results[row.key]
              return (
                <div key={row.key} className="flex items-start gap-2">
                  <div className="flex-1">
                    <CounterpartyCombobox
                      token={token}
                      selected={row.agent}
                      onSelect={opt => patchRow(row.key, { agent: opt })}
                      lang={lang}
                    />
                  </div>
                  <div className="w-44">
                    <GroupedNumberInput
                      value={row.amount}
                      onChange={n => patchRow(row.key, { amount: n })}
                      placeholder="10 000 000"
                      className={`${INPUT_CLS} font-mono`}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(row.key)}
                    disabled={rows.length === 1}
                    title={t(lang, 'pwRemoveRow')}
                    className="w-9 h-9 mt-0.5 rounded-lg flex items-center justify-center border border-line text-muted hover:border-red-500 hover:text-red-500 transition-all disabled:opacity-30 disabled:hover:border-line disabled:hover:text-muted shrink-0"
                  >
                    <Trash2 size={15} />
                  </button>
                  {result && (
                    <div className="w-9 h-9 mt-0.5 flex items-center justify-center shrink-0" title={result.message}>
                      {result.status === 'success'
                        ? <CheckCircle2 size={18} className="text-green-600" />
                        : <XCircle size={18} className="text-red-600" />}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <button
            type="button"
            onClick={addRow}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-line text-xs text-muted hover:border-accent hover:text-accent transition-all"
          >
            <Plus size={13} />
            {t(lang, 'pwAddCounterparty')}
          </button>

          {remaining !== 0 && totalAmount > 0 && (
            <p className={`text-xs ${remaining < 0 ? 'text-red-500' : 'text-muted'}`}>
              {remaining < 0 ? t(lang, 'pwOverAllocated') : `${t(lang, 'pwRemaining')}: ${remaining.toLocaleString('ru-RU')} ${currencyIso}`}
            </p>
          )}

          {/* Results with links */}
          {Object.entries(results).some(([, r]) => r.link || r.message) && (
            <div className="pt-2 border-t border-line space-y-1.5">
              {rows.map(row => {
                const r = results[row.key]
                if (!r) return null
                return (
                  <div key={row.key} className="text-xs flex items-center gap-2">
                    <span className={r.status === 'success' ? 'text-green-700' : 'text-red-600'}>
                      {row.agent?.name ?? '—'}: {r.status === 'success' ? t(lang, 'pwRowSuccess') : `${t(lang, 'pwRowError')} — ${r.message}`}
                    </span>
                    {r.link && (
                      <a href={r.link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-accent hover:underline">
                        <ExternalLink size={11} />
                        {t(lang, 'pwViewDoc')}
                      </a>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Document type & legal entity ── */}
        <section className="bg-surface/75 backdrop-blur-sm rounded-xl border border-line card-shadow p-6 space-y-4">
          <h2 className="text-base font-semibold text-fg">{t(lang, 'pwDocSection')}</h2>

          <div className="flex gap-3">
            {(['cashin', 'paymentin'] as PaymentDocType[]).map(dt => (
              <button
                key={dt}
                type="button"
                onClick={() => setDocType(dt)}
                className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-all ${
                  docType === dt ? 'border-accent bg-accent/10 text-accent' : 'border-line text-muted hover:border-accent/50'
                }`}
              >
                {t(lang, dt === 'cashin' ? 'pwCashIn' : 'pwPaymentIn')}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5 block">{t(lang, 'pwOrganization')}</label>
              {organizations === null ? (
                <Skeleton className="h-9 w-full" />
              ) : organizations.length === 0 ? (
                <p className="text-xs text-faint py-2">{t(lang, 'pwNoOrganizations')}</p>
              ) : (
                <select value={orgId} onChange={e => setOrgId(e.target.value)} className={INPUT_CLS}>
                  {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
            </div>
            <div>
              <label className="text-xs font-semibold text-muted uppercase tracking-wide mb-1.5 block">{t(lang, 'pwPaymentPurpose')}</label>
              <input
                type="text"
                value={paymentPurpose}
                onChange={e => setPaymentPurpose(e.target.value)}
                placeholder={t(lang, 'pwPaymentPurposePlaceholder')}
                className={INPUT_CLS}
              />
            </div>
          </div>
        </section>

        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-accent text-white font-semibold text-sm hover:bg-accent-strong transition-all disabled:opacity-40"
        >
          {submitting && <Loader2 size={16} className="animate-spin" />}
          {submitting ? t(lang, 'pwSubmitting') : t(lang, 'pwSubmit')}
        </button>
      </main>
    </div>
  )
}
