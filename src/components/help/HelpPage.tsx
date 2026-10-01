import { ArrowUp, ExternalLink, Search } from 'lucide-react'
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useI18n } from '../../context/I18nContext'
import { useLazyCatalog } from '../../context/useLazyCatalog'
import { hasHelpMessages, loadHelpMessages, type Locale } from '../../i18n'
import type { HelpBlock, HelpDoc, HelpInline, HelpSection } from '../../help/types'
import { fold, matchesTerms, searchTerms } from '../table/model'
import { controlClass } from '../ui'

const GUIDES: Record<Locale, () => Promise<{ default: HelpDoc }>> = {
  en: () => import('virtual:help/en'),
  ru: () => import('virtual:help/ru'),
  'uz-Latn': () => import('virtual:help/uz-Latn'),
  'uz-Cyrl': () => import('virtual:help/uz-Cyrl'),
}

const SECTION_PARAM = 'section'
const MOBILE_SHOT_MAX = 600

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in values ? String(values[name]) : match))
}

function useGuide(locale: Locale): HelpDoc | null | 'failed' {
  const [loaded, setLoaded] = useState<{ locale: Locale; doc: HelpDoc | 'failed' } | null>(null)
  useEffect(() => {
    let cancelled = false
    GUIDES[locale]().then(
      (module) => {
        if (!cancelled) setLoaded({ locale, doc: module.default })
      },
      () => {
        if (!cancelled) setLoaded({ locale, doc: 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [locale])
  return loaded?.locale === locale ? loaded.doc : null
}

/** The user guide for the current language, with its screenshots, a search box and links into the app. */
export function HelpPage({ standalone = false }: { standalone?: boolean }) {
  const { t, locale } = useI18n()
  const catalog = useLazyCatalog(loadHelpMessages, hasHelpMessages)
  const doc = useGuide(locale)
  if (catalog === 'failed' || doc === 'failed') {
    return (
      <p role="alert" data-testid="help-failed" className="text-sm text-clay-ink">
        {catalog === 'ready' ? t('help.loadFailed') : t('errors.sqlite')}
      </p>
    )
  }
  if (catalog !== 'ready' || !doc) return <div role="status" aria-busy="true" className="min-h-40" />
  return <HelpView doc={doc} standalone={standalone} />
}

function HelpView({ doc, standalone }: { doc: HelpDoc; standalone: boolean }) {
  const { t } = useI18n()
  const [params] = useSearchParams()
  const target = params.get(SECTION_PARAM)
  const [query, setQuery] = useState('')
  const terms = useMemo(() => searchTerms(query), [query])
  const index = useMemo(() => doc.sections.map((section) => fold(section.text)), [doc])
  const visible = useMemo(() => (terms.length ? doc.sections.filter((_, position) => matchesTerms(index[position], terms)) : doc.sections), [doc, index, terms])

  useEffect(() => {
    if (!target) return
    setQuery('')
    const frame = window.requestAnimationFrame(() => {
      const element = document.getElementById(`help-${target}`)
      if (!element) return
      element.scrollIntoView({ block: 'start' })
      element.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [target, doc])

  return (
    <div data-testid="help-page" data-locale={doc.locale} className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10">
      <nav aria-label={t('help.contents')} className="lg:sticky lg:top-14 lg:max-h-[calc(100vh-5rem)] lg:self-start lg:overflow-y-auto">
        <h2 className="text-xs uppercase tracking-[0.18em] text-brass">{t('help.contents')}</h2>
        <ol data-testid="help-toc" className="mt-3 flex gap-1 overflow-x-auto pb-2 text-sm lg:grid lg:overflow-visible lg:pb-0">
          {doc.sections.map((section) => (
            <li key={section.id} className="shrink-0">
              <Link
                to={{ search: `?${SECTION_PARAM}=${section.id}` }}
                data-testid="help-toc-link"
                data-section={section.id}
                aria-current={target === section.id ? 'location' : undefined}
                className={`block rounded-xl px-3 py-1.5 ${target === section.id ? 'bg-brass-soft text-ink' : 'text-muted hover:bg-card hover:text-ink'}`}
              >
                {section.title}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <article className="min-w-0 max-w-3xl">
        <h1 id="help-top" tabIndex={-1} className="font-display text-4xl outline-none">
          {doc.title || t('help.title')}
        </h1>
        <div className="mt-3 grid gap-3">
          <Blocks blocks={doc.intro} />
        </div>
        <div className="mt-6">
          <label htmlFor="help-search" className="mb-1.5 block text-sm font-medium">
            {t('help.search')}
          </label>
          <div className="relative">
            <Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              id="help-search"
              data-testid="help-search"
              type="search"
              className={`${controlClass} pl-9`}
              value={query}
              placeholder={t('help.searchHint')}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setQuery('')
              }}
            />
          </div>
          <p aria-live="polite" data-testid="help-results" data-count={visible.length} className="mt-2 text-sm text-muted empty:hidden">
            {terms.length ? (visible.length ? fill(t('help.results'), { count: visible.length }) : t('help.noResults')) : ''}
          </p>
        </div>
        {visible.map((section) => (
          <SectionView key={section.id} section={section} />
        ))}
        <p className="mt-10 flex flex-wrap gap-4 border-t border-line pt-4 text-sm">
          <Link to={{ search: '' }} onClick={() => document.getElementById('help-top')?.focus()} className="inline-flex items-center gap-1 text-pine-ink hover:underline">
            <ArrowUp size={14} aria-hidden="true" />
            {t('help.backToTop')}
          </Link>
          <Link to={standalone ? '/health' : '/app/health'} className="text-pine-ink hover:underline">
            {t('help.healthLink')}
          </Link>
          {standalone ? (
            <Link to="/" className="text-pine-ink hover:underline">
              {t('help.backToSignIn')}
            </Link>
          ) : null}
        </p>
      </article>
    </div>
  )
}

function SectionView({ section }: { section: HelpSection }) {
  return (
    <section data-testid="help-section" data-section={section.id} aria-labelledby={`help-${section.id}`} className="mt-10 scroll-mt-16">
      <h2 id={`help-${section.id}`} tabIndex={-1} className="scroll-mt-16 font-display text-3xl outline-none">
        {section.title}
      </h2>
      <div className="mt-3 grid gap-3">
        <Blocks blocks={section.blocks} />
      </div>
    </section>
  )
}

function Blocks({ blocks }: { blocks: readonly HelpBlock[] }) {
  return blocks.map((block, position) => <BlockView key={position} block={block} />)
}

function BlockView({ block }: { block: HelpBlock }) {
  const { t } = useI18n()
  switch (block.t) {
    case 'p':
      return (
        <p className="leading-relaxed">
          <Inline nodes={block.v} />
        </p>
      )
    case 'h3':
      return (
        <h3 id={`help-${block.id}`} tabIndex={-1} className="mt-4 scroll-mt-16 text-xl font-semibold outline-none">
          <Inline nodes={block.v} />
        </h3>
      )
    case 'ul':
    case 'ol': {
      const List = block.t === 'ul' ? 'ul' : 'ol'
      return (
        <List className={`grid gap-1.5 pl-6 leading-relaxed ${block.t === 'ul' ? 'list-disc' : 'list-decimal'}`}>
          {block.items.map((item, position) => (
            <li key={position}>
              <Inline nodes={item} />
            </li>
          ))}
        </List>
      )
    }
    case 'note':
      return (
        <aside className="grid gap-2 rounded-2xl border border-brass/50 bg-brass-soft px-4 py-3 text-sm leading-relaxed">
          {block.v.map((paragraph, position) => (
            <p key={position}>
              <Inline nodes={paragraph} />
            </p>
          ))}
        </aside>
      )
    case 'table':
      return (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-left text-sm">
            <thead className="bg-card">
              <tr>
                {block.head.map((cell, position) => (
                  <th key={position} scope="col" className="px-3 py-2 font-medium">
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, position) => (
                    <td key={position} className="px-3 py-2 align-top">
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'img': {
      const narrow = block.width !== undefined && block.width < MOBILE_SHOT_MAX
      return (
        <figure className={`grid gap-1.5 ${narrow ? 'max-w-[300px]' : ''}`}>
          <a href={block.src} target="_blank" rel="noopener noreferrer" title={t('help.imageOpen')} className="block">
            <img
              src={block.src}
              alt={block.alt}
              width={block.width}
              height={block.height}
              loading="lazy"
              decoding="async"
              data-testid="help-image"
              className="h-auto w-full rounded-2xl border border-line bg-card"
            />
          </a>
          <figcaption className="text-xs text-muted">{block.alt}</figcaption>
        </figure>
      )
    }
    case 'open':
      return (
        <p>
          <Link to={block.to} data-testid="help-open" className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-card px-3 py-1.5 text-sm font-medium hover:border-brass">
            <Inline nodes={block.v} />
          </Link>
        </p>
      )
  }
}

function Inline({ nodes }: { nodes: readonly HelpInline[] }): ReactNode {
  return nodes.map((node, position) => <Fragment key={position}>{inlineNode(node)}</Fragment>)
}

function inlineNode(node: HelpInline): ReactNode {
  switch (node.t) {
    case 'text':
      return node.v
    case 'code':
      return <code className="rounded bg-brass-soft px-1 py-0.5 text-[0.9em]">{node.v}</code>
    case 'strong':
      return (
        <strong className="font-semibold">
          <Inline nodes={node.v} />
        </strong>
      )
    case 'section':
      return (
        <Link to={{ search: `?${SECTION_PARAM}=${node.id}` }} className="text-pine-ink underline-offset-2 hover:underline">
          <Inline nodes={node.v} />
        </Link>
      )
    case 'route':
      return (
        <Link to={node.to} className="text-pine-ink underline-offset-2 hover:underline">
          <Inline nodes={node.v} />
        </Link>
      )
    case 'external':
      return (
        <a href={node.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-pine-ink underline-offset-2 hover:underline">
          <Inline nodes={node.v} />
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      )
  }
}
