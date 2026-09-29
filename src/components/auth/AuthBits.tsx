import { useI18n } from '../../context/I18nContext'
import { formatWait } from '../../lib/throttle'

export function ThrottleNotice({ remaining }: { remaining: number }) {
  const { t } = useI18n()
  if (remaining <= 0) return null
  return (
    <p role="alert" data-testid="throttled" className="rounded-xl bg-clay/10 px-3 py-2 text-sm text-clay-ink">
      {t('security.throttled')} <span className="font-mono tabular-nums">{formatWait(remaining)}</span>
    </p>
  )
}

export function PasswordHint() {
  const { t } = useI18n()
  return <span className="mt-1 block text-xs text-muted">{t('security.passwordHint')}</span>
}
