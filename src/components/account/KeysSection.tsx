import { useI18n } from '../../context/I18nContext'
import { useVault } from '../../context/VaultContext'
import { Fingerprint } from '../keys/Fingerprint'
import { KeysCatalog } from '../keys/KeysCatalog'
import { Panel } from '../ui'

/** For a per-person-keys vault: the founder key everyone compares on a first sign-in in a new browser. */
export function KeysSection() {
  const { keysInfo } = useVault()
  if (!keysInfo) return null
  return (
    <KeysCatalog>
      <KeysSectionBody fingerprint={keysInfo.fingerprint} founder={keysInfo.founder} />
    </KeysCatalog>
  )
}

function KeysSectionBody({ fingerprint, founder }: { fingerprint: string; founder: boolean }) {
  const { t } = useI18n()
  return (
    <Panel className="max-w-2xl">
      <section data-testid="keys-section" className="grid gap-3">
        <h2 className="font-display text-2xl">{t('keys.account.title')}</h2>
        <p className="text-sm text-muted">{t('keys.account.help')}</p>
        <p className="text-sm font-medium">{t('keys.account.founder')}</p>
        <Fingerprint value={fingerprint} testId="account-fingerprint" />
        {founder ? <p className="text-sm">{t('keys.account.you')}</p> : null}
      </section>
    </Panel>
  )
}
