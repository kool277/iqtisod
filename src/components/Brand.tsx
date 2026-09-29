import { useI18n } from '../context/I18nContext'

export const BRAND_MARK = 'جيبي'

/** The Arabic-script logo mark. Decorative: pair it with the localized name for assistive tech. */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <span dir="rtl" lang="ar" aria-hidden="true" data-testid="brand-mark" className={`font-brand leading-none ${className}`}>
      {BRAND_MARK}
    </span>
  )
}

/** Logo mark with the localized product name, for sign-in and status screens. */
export function BrandLockup({ size = 'md', className = '' }: { size?: 'md' | 'lg'; className?: string }) {
  const { t } = useI18n()
  return (
    <span data-testid="brand-lockup" className={`inline-flex items-baseline gap-3 ${className}`}>
      <BrandMark className={size === 'lg' ? 'text-5xl' : 'text-4xl'} />
      <span className={`font-display leading-none ${size === 'lg' ? 'text-3xl' : 'text-2xl'}`}>{t('app.name')}</span>
    </span>
  )
}
