import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { BrandLockup } from './Brand'
import { HealthPage } from './health/HealthPage'
import { HelpPage } from './help/HelpPage'
import { Preferences } from './Preferences'
import { useI18n } from '../context/I18nContext'

/** The frame for pages people can open before signing in: the brand, the language and theme, and a way back. */
function SupportFrame({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  return (
    <div className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 md:px-8">
        <Link to="/" aria-label={t('app.name')} className="hover:text-brass">
          <BrandLockup />
        </Link>
        <Preferences />
      </header>
      <main id="content" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-6 outline-none md:px-8 md:py-8">
        {children}
      </main>
    </div>
  )
}

export function HealthStandalone() {
  return (
    <SupportFrame>
      <HealthPage mode="standalone" />
    </SupportFrame>
  )
}

export function HelpStandalone() {
  return (
    <SupportFrame>
      <HelpPage standalone />
    </SupportFrame>
  )
}
