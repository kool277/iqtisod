import { useI18n } from '../context/I18nContext'
import { useTheme, type ThemeSetting } from '../context/ThemeContext'
import { LOCALES, type Locale } from '../i18n'

const THEMES: ThemeSetting[] = ['system', 'light', 'dark']

const LOCALE_LABELS: Record<Locale, string> = {
  'uz-Latn': 'Oʻzbekcha',
  'uz-Cyrl': 'Ўзбекча',
  ru: 'Русский',
  en: 'English',
}

export function Preferences() {
  const { t, locale, setLocale } = useI18n()
  const { setting, setSetting } = useTheme()

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor="language-select">
        {t('lang.label')}
      </label>
      <select
        id="language-select"
        data-testid="language-select"
        className="rounded-full border border-line bg-card px-3 py-1.5 text-sm"
        value={locale}
        onChange={(event) => setLocale(event.target.value as Locale)}
      >
        {LOCALES.map((item) => (
          <option key={item} value={item}>
            {LOCALE_LABELS[item]}
          </option>
        ))}
      </select>
      <div className="flex rounded-full border border-line bg-card p-1" role="group" aria-label={t('theme.label')}>
        {THEMES.map((item) => (
          <button
            key={item}
            type="button"
            data-testid={`theme-${item}`}
            aria-pressed={setting === item}
            className={`rounded-full px-3 py-1 text-sm ${setting === item ? 'bg-brass-soft text-ink' : 'text-muted'}`}
            onClick={() => setSetting(item)}
          >
            {t(`theme.${item}`)}
          </button>
        ))}
      </div>
    </div>
  )
}
