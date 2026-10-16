import { useState } from 'react'
import { formatFingerprint } from '../../crypto/sign'
import { useI18n } from '../../context/I18nContext'

/** The founder key's fingerprint, grouped for reading out loud, with a copy button. */
export function Fingerprint({ value, testId }: { value: string; testId: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const text = formatFingerprint(value)
  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-paper px-4 py-3">
      <code data-testid={testId} className="font-mono text-lg tracking-wider">
        {text}
      </code>
      <button type="button" className="text-sm text-pine-ink hover:underline" onClick={() => void copy()}>
        {copied ? t('keys.notice.copied') : t('keys.notice.copy')}
      </button>
    </div>
  )
}
