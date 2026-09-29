import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeSetting = 'light' | 'dark' | 'system'

const THEME_KEY = 'moliya.theme'

type ThemeApi = {
  setting: ThemeSetting
  resolved: 'light' | 'dark'
  setSetting: (setting: ThemeSetting) => void
}

const ThemeContext = createContext<ThemeApi | null>(null)

function isTheme(value: string | null): value is ThemeSetting {
  return value === 'light' || value === 'dark' || value === 'system'
}

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(resolved: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.documentElement.style.colorScheme = resolved
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [setting, setSettingState] = useState<ThemeSetting>(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return isTheme(saved) ? saved : 'system'
  })
  const [resolved, setResolved] = useState<'light' | 'dark'>(() => (setting === 'system' ? systemTheme() : setting))

  useEffect(() => {
    const next = setting === 'system' ? systemTheme() : setting
    setResolved(next)
    applyTheme(next)
    if (setting !== 'system') return
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      const theme = media.matches ? 'dark' : 'light'
      setResolved(theme)
      applyTheme(theme)
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [setting])

  const setSetting = (next: ThemeSetting) => {
    localStorage.setItem(THEME_KEY, next)
    setSettingState(next)
  }

  const value = useMemo(() => ({ setting, resolved, setSetting }), [setting, resolved])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeApi {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('Theme provider is missing')
  return value
}
