import { useState, useEffect } from 'react'
import { Sun, Moon, LogOut } from 'lucide-react'
import { AppContext, useAppContext } from './context/AppContext'
import type { Theme } from './context/AppContext'
import type { CurrencyRate } from './api/moysklad'
import { setApiBase } from './api/moysklad'
import { parseLang } from './i18n'
import type { Lang } from './i18n'
import PaymentWidgetPage from './pages/PaymentWidgetPage'
import CustomerOrderPage from './pages/CustomerOrderPage'
import LoginScreen from './components/LoginScreen'

const TOKEN_KEY = 'oy-ms-token'
const USER_KEY = 'oy-ms-user'
// Vendor backend of the installed MoySklad solution (see backend/).
const BACKEND_URL = (import.meta.env.VITE_BACKEND_URL as string | undefined)
  ?? 'https://widget-backend.oymoysklad.com'

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

function App() {
  const rawLang = getUrlParam('lang')

  // Token comes from a URL param (dev/testing) or a saved login that persists
  // across browser sessions (localStorage) until the employee logs out.
  const [token, setToken] = useState<string | null>(() => {
    const urlToken = getUrlParam('token')
    if (urlToken) return urlToken
    try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
  })
  const [userName, setUserName] = useState<string>(() => {
    try { return localStorage.getItem(USER_KEY) ?? '' } catch { return '' }
  })
  const [lang, setLang] = useState<Lang>(parseLang(rawLang))
  const [currencies, setCurrencies] = useState<CurrencyRate[]>([])
  const [theme, setThemeState] = useState<Theme>(getInitialTheme)
  // Opened inside MoySklad as an installed solution: it passes ?contextKey=…,
  // which the backend exchanges for a session — the employee signs in to nothing.
  const [booting, setBooting] = useState<boolean>(() => !!getUrlParam('contextKey'))

  useEffect(() => {
    const contextKey = getUrlParam('contextKey')
    if (!contextKey) return
    let alive = true
    fetch(`${BACKEND_URL}/widget/session?contextKey=${encodeURIComponent(contextKey)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { session?: string; name?: string }) => {
        if (!alive || !d.session) return
        // From here every API call goes through the backend, which holds the
        // account's real token — it never reaches the browser.
        setApiBase(`${BACKEND_URL}/api/moysklad`)
        setUserName(d.name ?? '')
        setToken(d.session)
      })
      .catch(() => { /* fall back to the login screen below */ })
      .finally(() => { if (alive) setBooting(false) })
    return () => { alive = false }
  }, [])

  function handleLogin(tok: string, name: string) {
    try {
      localStorage.setItem(TOKEN_KEY, tok)
      localStorage.setItem(USER_KEY, name)
    } catch { /* ignore */ }
    setUserName(name)
    setToken(tok)
  }

  function logout() {
    try {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
    } catch { /* ignore */ }
    setUserName('')
    setToken(null)
  }

  // A 401 from any request means the token was revoked / the session expired —
  // drop back to the login screen.
  useEffect(() => {
    const onExpired = () => {
      try {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
      } catch { /* ignore */ }
      setUserName('')
      setToken(null)
    }
    window.addEventListener('ms:session-expired', onExpired)
    return () => window.removeEventListener('ms:session-expired', onExpired)
  }, [])

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  const setTheme = (t: Theme) => {
    setThemeState(t)
    try { localStorage.setItem('oy-theme', t) } catch { /* ignore */ }
  }

  if (booting) {
    return (
      <div className="fabric-bg min-h-screen flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  // Outside MoySklad (or if the app session could not be established) the widget
  // still works with a personal login.
  if (!token) return <LoginScreen onLogin={handleLogin} />

  return (
    <AppContext.Provider value={{ token, userName, logout, lang, setLang, currencies, setCurrencies, theme, setTheme }}>
      <Shell />
    </AppContext.Provider>
  )
}

type Section = 'payment' | 'order'

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'payment', label: 'Разбивка платежа' },
  { id: 'order', label: 'Заказ покупателя' },
]

function Shell() {
  const { theme, setTheme, userName, logout } = useAppContext()
  const [section, setSection] = useState<Section>('payment')
  return (
    <div className="h-screen flex flex-col overflow-hidden bg-base">
      {/* Section tabs */}
      <nav className="shrink-0 h-10 flex items-end gap-1 px-3 border-b border-line bg-surface-2">
        {SECTIONS.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            className={`px-4 h-9 -mb-px text-sm font-medium border-b-2 transition-colors ${
              section === s.id
                ? 'border-accent text-accent'
                : 'border-transparent text-muted hover:text-fg'
            }`}
          >
            {s.label}
          </button>
        ))}
        <div className="flex-1" />
        {userName && <span className="mb-2 hidden sm:inline text-xs text-muted max-w-[200px] truncate" title={userName}>{userName}</span>}
        <button
          type="button"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          aria-label="Переключить тему"
          className="mb-0.5 w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-fg hover:bg-surface-3 transition-colors"
        >
          {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          type="button"
          onClick={logout}
          title="Выйти"
          aria-label="Выйти"
          className="mb-0.5 w-8 h-8 flex items-center justify-center rounded-md text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
        >
          <LogOut size={16} />
        </button>
      </nav>
      <div className="flex-1 overflow-hidden">
        {section === 'payment' ? <PaymentWidgetPage /> : <CustomerOrderPage />}
      </div>
    </div>
  )
}

export default App
