import { createContext, useContext } from 'react'
import type { CurrencyRate } from '../api/moysklad'
import type { Lang } from '../i18n'

export type Theme = 'light' | 'dark'

export interface AppContextValue {
  token: string
  lang: Lang
  setLang: (l: Lang) => void
  currencies: CurrencyRate[]
  setCurrencies: (c: CurrencyRate[]) => void
  theme: Theme
  setTheme: (t: Theme) => void
}

export const AppContext = createContext<AppContextValue | null>(null)

export function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error('useAppContext must be used inside AppContext.Provider')
  return ctx
}
