import { useI18n } from '../context/I18nContext'
import { usePeriod } from '../context/PeriodContext'
import type { PeriodPreset } from '../lib/dates'

const PRESETS: PeriodPreset[] = ['day', 'week', 'month', 'lastMonth', 'ytd', 'custom']

export function PeriodPicker() {
  const { t } = useI18n()
  const { preset, setPreset, customStart, customEnd, setCustomStart, setCustomEnd } = usePeriod()

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="flex flex-wrap gap-1" role="group" aria-label={t('filter.custom')}>
        {PRESETS.map((item) => (
          <button
            key={item}
            type="button"
            data-testid={`period-${item}`}
            aria-pressed={preset === item}
            className={`rounded-full px-3 py-1.5 text-sm ${preset === item ? 'bg-pine text-on-pine' : 'bg-card text-muted border border-line'}`}
            onClick={() => setPreset(item)}
          >
            {t(`filter.${item === 'lastMonth' ? 'lastMonth' : item}`)}
          </button>
        ))}
      </div>
      {preset === 'custom' ? (
        <div className="flex flex-wrap gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted">{t('filter.from')}</span>
            <input
              data-testid="period-from"
              type="date"
              className="rounded-xl border border-line bg-card px-3 py-2"
              value={customStart}
              onChange={(event) => setCustomStart(event.target.value)}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">{t('filter.to')}</span>
            <input
              data-testid="period-to"
              type="date"
              className="rounded-xl border border-line bg-card px-3 py-2"
              value={customEnd}
              onChange={(event) => setCustomEnd(event.target.value)}
            />
          </label>
        </div>
      ) : null}
    </div>
  )
}
