import type { ReactNode } from 'react'
import { useLazyCatalog } from '../../context/useLazyCatalog'
import { hasKeysMessages, loadKeysMessages } from '../../i18n'

/** Renders `children` once the `keys.*` strings for the current language have loaded. */
export function KeysCatalog({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const catalog = useLazyCatalog(loadKeysMessages, hasKeysMessages)
  return catalog === 'ready' ? children : fallback
}
