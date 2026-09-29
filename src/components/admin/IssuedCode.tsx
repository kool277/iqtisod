import { useState } from 'react'
import { Button } from '../ui'
import { useI18n } from '../../context/I18nContext'
import { copySecret } from '../../lib/clipboard'
import { formatWhen } from '../../lib/money'
import type { IssuedGrant } from '../../services/grant.service'

const CLIPBOARD_SECONDS = 60

function registerLink(grant: IssuedGrant): string {
  const params = new URLSearchParams()
  if (grant.kind === 'RESET') params.set('kind', 'reset')
  params.set('email', grant.email)
  params.set('code', grant.code)
  return `${window.location.origin}${window.location.pathname}#/register?${params.toString()}`
}

/** Shows a freshly issued code once. Nothing here is stored; closing it discards the code. */
export function IssuedCode({ grant, onDone }: { grant: IssuedGrant; onDone: () => void }) {
  const { t, locale } = useI18n()
  const [copied, setCopied] = useState(false)

  const copy = (text: string) => {
    void copySecret(text, CLIPBOARD_SECONDS)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
  }

  return (
    <div data-testid="issued-code-panel" className="grid gap-3 rounded-2xl border border-pine/40 bg-paper p-4">
      <p className="text-sm">
        {grant.kind === 'RESET' ? t('invites.resetFor') : t('invites.codeFor')} <span className="break-all font-medium">{grant.email}</span>
      </p>
      <p data-testid="issued-code" className="select-all break-all font-mono text-lg tracking-wider text-pine-ink">
        {grant.code}
      </p>
      <p className="text-sm text-muted">
        {t('invites.codeOnce')} {formatWhen(grant.expiresAt, locale)}.
      </p>
      <p role="note" className="rounded-xl border border-brass/50 bg-brass-soft px-3 py-2 text-xs">
        {t('invites.backupWarn')}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="quiet" data-testid="copy-code" onClick={() => copy(grant.code)}>
          {t('invites.copyCode')}
        </Button>
        <Button variant="quiet" data-testid="copy-link" onClick={() => copy(registerLink(grant))}>
          {t('invites.copyLink')}
        </Button>
        <Button data-testid="code-done" onClick={onDone}>
          {t('invites.done')}
        </Button>
      </div>
      {copied ? (
        <p role="status" className="text-xs text-pine-ink">
          {t('invites.copied')}
        </p>
      ) : null}
    </div>
  )
}
