import { Button } from './ui'
import { useI18n } from '../context/I18nContext'
import { useVault } from '../context/VaultContext'
import { useUpdateAvailable } from '../lib/updates'

export function UpdateBanner() {
  const { t } = useI18n()
  const { status, lock } = useVault()
  const available = useUpdateAvailable()
  if (!available) return null

  const reload = async () => {
    if (status === 'ready') await lock()
    window.location.reload()
  }

  return (
    <div role="status" data-testid="update-banner" className="flex flex-wrap items-center justify-center gap-3 border-b border-line bg-brass-soft px-4 py-2 text-sm">
      <span>{t('update.available')}</span>
      <Button variant="quiet" className="py-1" onClick={() => void reload()}>
        {t('update.reload')}
      </Button>
    </div>
  )
}
