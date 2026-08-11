import { useState } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { login, getMyContext, isAllowedAccount } from '../api/moysklad'

/**
 * Login screen: an employee signs in with their own MoySklad login and password.
 * We exchange them for a personal token (never storing the password) and hand it
 * up so every request runs as that employee.
 */
export default function LoginScreen({ onLogin }: { onLogin: (token: string, name: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!username.trim() || !password) return
    setLoading(true); setError(null)
    try {
      const token = await login(username.trim(), password)
      const { name, accountId } = await getMyContext(token)
      // Виджет предназначен одному клиенту — чужие аккаунты МойСклад не пускаем.
      if (!isAllowedAccount(accountId)) {
        throw new Error('Этот аккаунт МойСклад не имеет доступа к виджету')
      }
      onLogin(token, name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setLoading(false)
    }
  }

  return (
    <div className="fabric-bg min-h-screen flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="bg-surface/80 backdrop-blur-sm rounded-2xl border border-line p-8 w-full max-w-sm space-y-5 shadow-xl"
      >
        <div className="text-center space-y-1">
          <h1 className="text-lg font-bold text-fg">Вход в систему</h1>
          <p className="text-xs text-muted">Войдите под своим логином и паролем МойСклад</p>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="block mb-1 text-xs font-medium text-muted">Логин</span>
            <input
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              className="w-full h-10 px-3 rounded-md border border-line bg-surface text-fg text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
              placeholder="Логин МойСклад"
            />
          </label>
          <label className="block">
            <span className="block mb-1 text-xs font-medium text-muted">Пароль</span>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full h-10 px-3 rounded-md border border-line bg-surface text-fg text-sm focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
              placeholder="••••••••"
            />
          </label>
        </div>

        {error && <p className="text-xs text-red-600 text-center">{error}</p>}

        <button
          type="submit"
          disabled={loading || !username.trim() || !password}
          className="w-full h-10 flex items-center justify-center gap-2 rounded-md bg-accent text-white text-sm font-semibold hover:bg-accent-strong transition-all disabled:opacity-40"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />}
          {loading ? 'Вход…' : 'Войти'}
        </button>
      </form>
    </div>
  )
}
