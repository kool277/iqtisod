import { Link } from 'react-router-dom'
import { BrandLockup } from './Brand'
import { useI18n } from '../context/I18nContext'

/** For addresses no route matches. `standalone` draws it without the app shell, for paths outside `/app`. */
export function NotFound({ standalone = false }: { standalone?: boolean }) {
  const { t } = useI18n()
  const body = (
    <section data-testid="not-found" className="grid max-w-xl gap-3">
      <h1 className="font-display text-4xl">{t('notFound.title')}</h1>
      <p className="text-sm text-muted">{t('notFound.body')}</p>
      <Link to="/app" data-testid="not-found-home" className="mt-2 inline-flex w-fit rounded-xl bg-pine px-4 py-2.5 text-sm font-medium text-on-pine">
        {t('notFound.home')}
      </Link>
    </section>
  )
  if (!standalone) return body
  return (
    <main className="mx-auto grid min-h-screen max-w-xl content-center gap-8 p-6">
      <BrandLockup />
      {body}
    </main>
  )
}
