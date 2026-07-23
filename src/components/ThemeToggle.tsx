import { Sun, Moon } from 'lucide-react'
import { useAppContext } from '../context/AppContext'
import { t } from '../i18n'

export function ThemeToggle() {
  const { theme, setTheme, lang } = useAppContext()
  const isDark = theme === 'dark'
  return (
    <button
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className="w-9 h-9 rounded-xl flex items-center justify-center border border-line text-muted hover:border-accent hover:text-accent transition-all"
      title={isDark ? t(lang, 'themeLight') : t(lang, 'themeDark')}
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  )
}
