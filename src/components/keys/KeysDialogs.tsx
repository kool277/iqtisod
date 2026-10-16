import { useState, type FormEvent } from 'react'
import { Dialog } from '../Dialog'
import { Button, Field, Notice, controlClass } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { textForError } from '../../lib/errors'
import { fillTemplate } from '../../lib/template'
import { Fingerprint } from './Fingerprint'
import { KeysCatalog } from './KeysCatalog'

/**
 * Shown once after a per-person-keys vault is created, upgraded or joined in this browser: the founder key to write
 * down (founder) or to compare with the admin (anyone else).
 */
export function FingerprintNotice() {
  const { fingerprintNotice, dismissFingerprintNotice, keysInfo } = useVault()
  if (!fingerprintNotice) return null
  return (
    <KeysCatalog>
      <FingerprintNoticeBody fingerprint={fingerprintNotice} founder={keysInfo?.founder ?? false} onClose={dismissFingerprintNotice} />
    </KeysCatalog>
  )
}

function FingerprintNoticeBody({ fingerprint, founder, onClose }: { fingerprint: string; founder: boolean; onClose: () => void }) {
  const { t } = useI18n()
  return (
    <Dialog title={founder ? t('keys.notice.founderTitle') : t('keys.notice.joinedTitle')} onClose={onClose} testId="fingerprint-notice">
      <p className="text-sm text-muted">{founder ? t('keys.notice.founderBody') : t('keys.notice.joinedBody')}</p>
      <div className="mt-4">
        <Fingerprint value={fingerprint} testId="notice-fingerprint" />
      </div>
      <div className="mt-5 flex justify-end">
        <Button data-testid="fingerprint-done" onClick={onClose}>
          {t('keys.notice.done')}
        </Button>
      </div>
    </Dialog>
  )
}

/** The founder upgrade, offered to an admin of a 1.x vault in a build with per-person keys (design 5.2 and 6.1). */
export function UpgradeOffer({ reinvites }: { reinvites: number }) {
  const { upgradeOffered } = useVault()
  if (!upgradeOffered) return null
  return (
    <KeysCatalog>
      <UpgradeOfferBody reinvites={reinvites} />
    </KeysCatalog>
  )
}

function UpgradeOfferBody({ reinvites }: { reinvites: number }) {
  const { t } = useI18n()
  const { upgradeKeys, postponeUpgrade } = useVault()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await upgradeKeys(password)
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPassword('')
      setPending(false)
    }
  }

  return (
    <Dialog title={t('keys.upgrade.title')} onClose={postponeUpgrade} testId="upgrade-offer">
      <form className="grid gap-4" onSubmit={(event) => void onSubmit(event)}>
        <p className="text-sm">{t('keys.upgrade.body')}</p>
        <p className="text-sm font-medium" data-testid="upgrade-reinvites">
          {fillTemplate(t('keys.upgrade.people'), { count: String(reinvites) })}
        </p>
        <p className="text-sm text-muted">{t('keys.upgrade.keep')}</p>
        {error ? <Notice>{error}</Notice> : null}
        <Field label={t('keys.upgrade.password')}>
          <input
            data-testid="upgrade-password"
            type="password"
            autoComplete="current-password"
            className={controlClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="quiet" data-testid="upgrade-later" onClick={postponeUpgrade}>
            {t('keys.upgrade.later')}
          </Button>
          <Button type="submit" data-testid="upgrade-confirm" disabled={pending || password === ''}>
            {pending ? t('keys.upgrade.working') : t('keys.upgrade.confirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
