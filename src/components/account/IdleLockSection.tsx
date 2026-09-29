import { Field, Panel, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import type { MessageKey } from '../../i18n'
import { IDLE_CHOICES, isIdleMinutes, type IdleMinutes } from '../../lib/idle'

const LABELS: Record<IdleMinutes, MessageKey> = {
  5: 'security.idle5',
  15: 'security.idle15',
  30: 'security.idle30',
  60: 'security.idle60',
}

export function IdleLockSection() {
  const { t } = useI18n()
  const { idleMinutes, setIdleMinutes } = useVault()
  return (
    <Panel className="max-w-2xl">
      <h2 className="font-display text-2xl">{t('security.idleTitle')}</h2>
      <p className="mb-4 mt-1 text-sm text-muted">{t('security.idleIntro')}</p>
      <div className="max-w-xs">
        <Field label={t('security.idleTitle')}>
          <select
            data-testid="idle-minutes"
            className={controlClass}
            value={idleMinutes}
            onChange={(event) => {
              const value = Number(event.target.value)
              if (isIdleMinutes(value)) setIdleMinutes(value)
            }}
          >
            {IDLE_CHOICES.map((value) => (
              <option key={value} value={value}>
                {t(LABELS[value])}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Panel>
  )
}
