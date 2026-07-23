import { useAppContext } from '../context/AppContext'
import type { Lang } from '../i18n'

const LANGS: Lang[] = ['ru', 'en', 'kk', 'uz']

export function LangSwitcher() {
  const { lang, setLang } = useAppContext()

  function handleChange(l: Lang) {
    setLang(l)
    const url = new URL(window.location.href)
    url.searchParams.set('lang', l)
    window.history.replaceState({}, '', url.toString())
  }

  return (
    <div className="flex items-center gap-0.5 border border-line rounded-lg p-0.5">
      {LANGS.map(l => (
        <button
          key={l}
          onClick={() => handleChange(l)}
          className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${
            lang === l
              ? 'bg-fg text-surface-3'
              : 'text-muted hover:text-fg'
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  )
}
