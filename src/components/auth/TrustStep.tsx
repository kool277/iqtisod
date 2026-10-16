import { useState } from 'react'
import { Button, Notice } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { textForError } from '../../lib/errors'
import { Fingerprint } from '../keys/Fingerprint'
import { KeysCatalog } from '../keys/KeysCatalog'

/**
 * The first sign-in to a per-person-keys vault in this browser (trust on first use, design 3.8 step 1): the person
 * compares the founder key with their admin before the vault opens, and the key is pinned only once they go on.
 */
export function TrustStep() {
  return (
    <KeysCatalog fallback={<div role="status" aria-busy="true" className="min-h-40" />}>
      <TrustStepBody />
    </KeysCatalog>
  )
}

function TrustStepBody() {
  const { t } = useI18n()
  const { trustFingerprint, confirmTrust, cancelTrust } = useVault()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onConfirm() {
    setPending(true)
    setError(null)
    try {
      await confirmTrust()
    } catch (caught) {
      setError(textForError(caught, t))
    } finally {
      setPending(false)
    }
  }

  return (
    <div data-testid="trust-step">
      <h2 className="mt-2 font-display text-4xl">{t('keys.trust.title')}</h2>
      <p className="mt-2 text-sm text-muted">{t('keys.trust.body')}</p>
      <div className="mt-6 grid gap-4">
        {error ? <Notice>{error}</Notice> : null}
        <p className="text-sm font-medium">{t('keys.trust.label')}</p>
        {trustFingerprint ? <Fingerprint value={trustFingerprint} testId="trust-fingerprint" /> : null}
        <div className="flex flex-wrap gap-2">
          <Button data-testid="trust-confirm" disabled={pending} onClick={() => void onConfirm()}>
            {t('keys.trust.confirm')}
          </Button>
          <Button variant="quiet" data-testid="trust-cancel" onClick={cancelTrust}>
            {t('keys.trust.cancel')}
          </Button>
        </div>
      </div>
    </div>
  )
}
