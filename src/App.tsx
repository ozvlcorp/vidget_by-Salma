import { useState, useEffect } from 'react'
import { Sun, Moon, LogOut, Wallet, ClipboardList, BarChart3, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AppContext, useAppContext } from './context/AppContext'
import type { Theme } from './context/AppContext'
import type { CurrencyRate } from './api/moysklad'
import { setApiBase } from './api/moysklad'
import { parseLang } from './i18n'
import type { Lang } from './i18n'
import PaymentWidgetPage from './pages/PaymentWidgetPage'
import CustomerOrderPage from './pages/CustomerOrderPage'
import DashboardPage from './pages/DashboardPage'
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

/** Экран для прямого захода: виджет работает как решение внутри МойСклад. */
function OpenFromMoyskladScreen() {
  return (
    <div className="fabric-bg app-minh flex items-center justify-center p-6">
      <div className="bg-surface/80 backdrop-blur-sm rounded-2xl border border-line p-8 max-w-sm text-center space-y-2 shadow-xl">
        <p className="text-sm font-semibold text-fg">Откройте виджет из МойСклад</p>
        <p className="text-xs text-muted">
          Раздел «Решения» → «SALMA Заказ и приход денег»
        </p>
      </div>
    </div>
  )
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
      <div className="fabric-bg app-minh flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }
  // Обычно (и по умолчанию) виджет открывается по прямой ссылке и просит вход.
  // Только для сборки, которая пойдёт на модерацию, включается VITE_HIDE_LOGIN=1:
  // правила МойСклад запрещают запрашивать логин/пароль, поэтому там форма
  // доступна лишь по ссылке с ?login=1.
  if (!token) {
    const hideDirectLogin = import.meta.env.VITE_HIDE_LOGIN === '1' && !getUrlParam('login')
    return hideDirectLogin
      ? <OpenFromMoyskladScreen />
      : <LoginScreen onLogin={handleLogin} />
  }

  return (
    <AppContext.Provider value={{ token, userName, logout, lang, setLang, currencies, setCurrencies, theme, setTheme }}>
      <Shell />
    </AppContext.Provider>
  )
}

type Section = 'payment' | 'order' | 'dashboard'

const SECTIONS: Array<{ id: Section; label: string; Icon: LucideIcon }> = [
  { id: 'payment', label: 'Разбивка платежа', Icon: Wallet },
  { id: 'order', label: 'Заказ покупателя', Icon: ClipboardList },
  { id: 'dashboard', label: 'Мои продажи', Icon: BarChart3 },
]

const NAV_KEY = 'oy-nav-expanded'

function Shell() {
  const { theme, setTheme, userName, logout } = useAppContext()
  const [section, setSection] = useState<Section>('payment')
  // Свёрнутое/развёрнутое меню запоминается между визитами.
  const [expanded, setExpanded] = useState<boolean>(() => {
    try { return localStorage.getItem(NAV_KEY) !== '0' } catch { return true }
  })
  function toggleNav() {
    setExpanded(v => {
      try { localStorage.setItem(NAV_KEY, v ? '0' : '1') } catch { /* ignore */ }
      return !v
    })
  }
  const label = (text: string) => (expanded ? <span className="truncate">{text}</span> : null)

  const current = SECTIONS.find(s => s.id === section)

  return (
    <div className="app-vh flex overflow-hidden bg-base">
      {/* Боковое меню (планшет и десктоп): сворачивается до иконок по клику.
          На телефоне вместо него — верхняя шапка и нижние вкладки. */}
      <nav
        className={`hidden md:flex shrink-0 flex-col border-r border-line bg-surface-2 transition-[width] duration-200 ease-out ${
          expanded ? 'w-56' : 'w-14'
        }`}
      >
        <div className="shrink-0 p-2">
          <button
            type="button"
            onClick={toggleNav}
            title={expanded ? 'Свернуть меню' : 'Развернуть меню'}
            aria-label={expanded ? 'Свернуть меню' : 'Развернуть меню'}
            aria-expanded={expanded}
            className="w-full h-9 flex items-center gap-3 px-3 rounded-lg text-muted hover:text-fg hover:bg-surface-3 transition-colors"
          >
            {expanded
              ? <PanelLeftClose size={18} className="shrink-0" />
              : <PanelLeftOpen size={18} className="shrink-0" />}
          </button>
        </div>
        <div className="flex-1 py-1 space-y-1 px-2 overflow-hidden">
          {SECTIONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              title={label}
              className={`w-full h-10 flex items-center gap-3 px-3 rounded-lg text-sm font-medium transition-colors ${
                section === id
                  ? 'bg-accent/10 text-accent'
                  : 'text-muted hover:text-fg hover:bg-surface-3'
              }`}
            >
              <Icon size={18} className="shrink-0" />
              {expanded && <span className="truncate">{label}</span>}
            </button>
          ))}
        </div>

        {/* Низ панели: кто вошёл, тема, выход */}
        <div className="shrink-0 border-t border-line p-2 space-y-1">
          {userName && expanded && (
            <p className="px-3 pb-1 text-xs text-muted truncate" title={userName}>{userName}</p>
          )}
          <button
            type="button"
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
            aria-label="Переключить тему"
            className="w-full h-9 flex items-center gap-3 px-3 rounded-lg text-sm text-muted hover:text-fg hover:bg-surface-3 transition-colors"
          >
            {theme === 'dark' ? <Sun size={16} className="shrink-0" /> : <Moon size={16} className="shrink-0" />}
            {label(theme === 'dark' ? 'Светлая тема' : 'Тёмная тема')}
          </button>
          <button
            type="button"
            onClick={logout}
            title="Выйти"
            aria-label="Выйти"
            className="w-full h-9 flex items-center gap-3 px-3 rounded-lg text-sm text-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <LogOut size={16} className="shrink-0" />
            {label('Выйти')}
          </button>
        </div>
      </nav>

      <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        {/* Телефон: шапка с названием раздела, темой и выходом */}
        <header className="md:hidden shrink-0 pt-safe border-b border-line bg-surface">
          <div className="h-12 flex items-center gap-2 px-3">
            {current && <current.Icon size={18} className="shrink-0 text-accent" />}
            <span className="flex-1 truncate text-sm font-semibold text-fg">{current?.label}</span>
            {/* На узком экране имя уступает место названию раздела */}
            {userName && <span className="hidden sm:block max-w-[38%] truncate text-[11px] text-muted">{userName}</span>}
            <button
              type="button"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="Переключить тему"
              className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-muted active:bg-surface-3"
            >
              {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <button
              type="button"
              onClick={logout}
              aria-label="Выйти"
              className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center text-muted active:bg-surface-3"
            >
              <LogOut size={18} />
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-hidden">
          {section === 'payment' ? <PaymentWidgetPage />
            : section === 'order' ? <CustomerOrderPage />
            : <DashboardPage />}
        </div>

        {/* Телефон: вкладки внизу — большая зона нажатия под большой палец */}
        <nav className="md:hidden shrink-0 border-t border-line bg-surface pb-safe">
          <div className="flex">
            {SECTIONS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setSection(id)}
                aria-current={section === id ? 'page' : undefined}
                className={`flex-1 h-14 flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                  section === id ? 'text-accent' : 'text-muted'
                }`}
              >
                <Icon size={20} className="shrink-0" />
                <span className="truncate max-w-full px-1">{label}</span>
              </button>
            ))}
          </div>
        </nav>
      </div>
    </div>
  )
}

export default App
