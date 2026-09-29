import { Monitor, Moon, Sun } from 'lucide-react'
import { useI18n } from '../context/I18nContext'
import { useTheme, type ThemeSetting } from '../context/ThemeContext'
import { LOCALES, type Locale } from '../i18n'

const THEMES: ThemeSetting[] = ['system', 'light', 'dark']

const THEME_ICONS: Record<ThemeSetting, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

const LOCALE_LABELS: Record<Locale, string> = {
  'uz-Latn': 'Oʻzbekcha',
  'uz-Cyrl': 'Ўзбекча',
  ru: 'Русский',
  en: 'English',
}

export function Preferences({ compact = false }: { compact?: boolean }) {
  const { t, locale, setLocale } = useI18n()
  const { setting, setSetting } = useTheme()

  return (
    <div className={`flex items-center ${compact ? 'shrink-0 gap-1.5' : 'flex-wrap gap-2'}`}>
      <label className="sr-only" htmlFor="language-select">
        {t('lang.label')}
      </label>
      <select
        id="language-select"
        data-testid="language-select"
        className={`rounded-full border border-line bg-card ${compact ? 'h-7 px-2 py-0 text-xs' : 'px-3 py-1.5 text-sm'}`}
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((item) => (
          <option key={item} value={item}>
            {LOCALE_LABELS[item]}
          </option>
        ))}
      </select>
      <div
        className={`flex rounded-full border border-line bg-card ${compact ? 'h-7 items-center p-0.5' : 'p-1'}`}
        role="group"
        aria-label={t('theme.label')}
      >
        {THEMES.map((item) => {
          const Icon = THEME_ICONS[item]
          const label = t(`theme.${item}`)
          return (
            <button
              key={item}
              type="button"
              data-testid={`theme-${item}`}
              aria-pressed={setting === item}
              aria-label={compact ? label : undefined}
              title={compact ? label : undefined}
              className={`rounded-full ${compact ? 'grid size-6 place-items-center' : 'px-3 py-1 text-sm'} ${setting === item ? 'bg-brass-soft text-ink' : 'text-muted'}`}
              onClick={() => setSetting(item)}
            >
              {compact ? <Icon size={14} aria-hidden="true" /> : label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
