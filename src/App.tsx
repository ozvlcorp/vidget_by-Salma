import { useState, useEffect } from 'react'
import { AppContext } from './context/AppContext'
import type { Theme } from './context/AppContext'
import type { CurrencyRate } from './api/moysklad'
import { parseLang } from './i18n'
import type { Lang } from './i18n'
import { t } from './i18n'
import PaymentWidgetPage from './pages/PaymentWidgetPage'

const BACKEND_URL = 'https://widget-backend.oymoysklad.com'
// TODO: set this to whatever name this widget is registered under on the backend above.
const WIDGET_NAME = 'payment-widget'

function getUrlParam(key: string): string | null {
  const url = new URL(window.location.href)
  return url.searchParams.get(key)
}

function getInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem('oy-theme')
    if (saved === 'light' || saved === 'dark') return saved
  } catch { /* ignore */ }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function LoadingScreen() {
  return (
    <div className="fabric-bg min-h-screen flex items-center justify-center">
      <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
    </div>
  )
}

function NoTokenScreen({ lang }: { lang: Lang }) {
  return (
    <div className="fabric-bg min-h-screen flex items-center justify-center p-6">
      <div className="bg-surface/70 backdrop-blur-sm rounded-2xl border border-line p-8 max-w-sm text-center space-y-3">
        <p className="text-sm font-semibold text-fg">{t(lang, 'tokenMissing')}</p>
      </div>
    </div>
  )
}

function App() {
  const rawLang = getUrlParam('lang')

  // Dev/testing: token in URL param — resolved synchronously so there's no
  // loading flash, and no state clash with the async backend-fetch path below.
  const [token, setToken] = useState<string | null>(() => getUrlParam('token'))
  const [tokenLoading, setTokenLoading] = useState<boolean>(() => !getUrlParam('token'))
  const [lang, setLang] = useState<Lang>(parseLang(rawLang))
  const [currencies, setCurrencies] = useState<CurrencyRate[]>([])
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)

  useEffect(() => {
    if (getUrlParam('token')) return // already resolved synchronously above
    // Production: MoySklad adds ?contextKey=X and ?accountId=X to iframe URL
    const contextKey = getUrlParam('contextKey')
    const accountId  = getUrlParam('accountId')
    const account    = getUrlParam('account')
    const qs = new URLSearchParams()
    if (contextKey) qs.set('contextKey', contextKey)
    if (accountId)  qs.set('accountId', accountId)
    if (account)    qs.set('account', account)
    const params = qs.toString() ? `?${qs.toString()}` : ''
    fetch(`${BACKEND_URL}/${WIDGET_NAME}/token${params}`)
      .then(r => r.json())
      .then((d: { access_token?: string }) => {
        if (d.access_token) setToken(d.access_token)
      })
      .catch(() => {})
      .finally(() => setTokenLoading(false))
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const setTheme = (t: Theme) => {
    setThemeState(t)
    try { localStorage.setItem('oy-theme', t) } catch { /* ignore */ }
  }

  if (tokenLoading) return <LoadingScreen />
  if (!token) return <NoTokenScreen lang={lang} />

  return (
    <AppContext.Provider value={{ token, lang, setLang, currencies, setCurrencies, theme, setTheme }}>
      <PaymentWidgetPage />
    </AppContext.Provider>
  )
}

export default App
