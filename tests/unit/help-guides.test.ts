import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { HelpSectionId } from '../../src/components/help/HelpLink'
import type { HelpBlock, HelpDoc, HelpInline } from '../../src/help/types'
import { HELP_LOCALES, guidePath, imageSize, inlineText, parseGuide, parseInline, type HelpLocale } from '../../tools/help-markdown'

const ROOT = resolve(import.meta.dirname, '../..')
const IMAGES = resolve(ROOT, 'docs/images')
const CONTEXT_SECTIONS: HelpSectionId[] = ['start', 'sign-in', 'dashboard', 'transactions', 'groups', 'users', 'safes', 'backup', 'settings', 'account', 'audit', 'health', 'troubleshooting']

function read(locale: HelpLocale): string {
  return readFileSync(resolve(ROOT, guidePath(locale)), 'utf8')
}

function parse(locale: HelpLocale): HelpDoc {
  return parseGuide(read(locale), {
    locale,
    imageSize: (src) => {
      const file = resolve(IMAGES, src.replace(/^help\//, ''))
      return existsSync(file) ? imageSize(readFileSync(file)) : null
    },
  })
}

function blocks(doc: HelpDoc): HelpBlock[] {
  return [...doc.intro, ...doc.sections.flatMap((section) => section.blocks)]
}

function inlines(block: HelpBlock): HelpInline[][] {
  switch (block.t) {
    case 'p':
    case 'h3':
    case 'open':
      return [block.v]
    case 'ul':
    case 'ol':
      return block.items
    case 'note':
      return block.v
    case 'table':
      return [...block.head, ...block.rows.flat()]
    case 'img':
      return []
  }
}

function walk(nodes: readonly HelpInline[], visit: (node: HelpInline) => void) {
  for (const node of nodes) {
    visit(node)
    if (node.t !== 'text' && node.t !== 'code') walk(node.v, visit)
  }
}

function anchors(doc: HelpDoc): Set<string> {
  const ids = new Set<string>()
  for (const section of doc.sections) {
    ids.add(section.id)
    for (const block of section.blocks) if (block.t === 'h3') ids.add(block.id)
  }
  return ids
}

describe('help markdown', () => {
  it('reads bold, code, section, route and external links, and keeps anything else as text', () => {
    expect(parseInline('Choose **Save** or `Esc`, see [Backups](#backup), [open](https://jaybi.uz/#/app/backup), [site](https://example.org/x), [admin](admin-guide.md) <b>x</b>')).toEqual([
      { t: 'text', v: 'Choose ' },
      { t: 'strong', v: [{ t: 'text', v: 'Save' }] },
      { t: 'text', v: ' or ' },
      { t: 'code', v: 'Esc' },
      { t: 'text', v: ', see ' },
      { t: 'section', id: 'backup', v: [{ t: 'text', v: 'Backups' }] },
      { t: 'text', v: ', ' },
      { t: 'route', to: '/app/backup', v: [{ t: 'text', v: 'open' }] },
      { t: 'text', v: ', ' },
      { t: 'external', href: 'https://example.org/x', v: [{ t: 'text', v: 'site' }] },
      { t: 'text', v: ', ' },
      { t: 'strong', v: [{ t: 'text', v: 'admin' }] },
      { t: 'text', v: ' <b>x</b>' },
    ])
  })

  it('never turns a script or a foreign address into a link', () => {
    for (const href of ['javascript:alert(1)', 'http://jaybi.uz/#/app', 'https://jaybi.uz/#/app/<x>', 'data:text/html,x', '//evil.example/']) {
      const [node] = parseInline(`[x](${href})`)
      expect(node.t === 'route' || node.t === 'section', href).toBe(false)
      if (node.t === 'external') expect(node.href.startsWith('https://')).toBe(true)
    }
    expect(parseInline('[x](https://jaybi.uz/#/app/users?section=a&b=1)')[0]).toMatchObject({ t: 'route', to: '/app/users?section=a&b=1' })
  })

  it('builds sections from anchored headings, drops the contents and the language line, and joins open buttons', () => {
    const doc = parseGuide(
      [
        '# Guide',
        '',
        '**English** · [Русский](ru/user-guide.md)',
        '',
        'Intro text.',
        '<a id="contents"></a>',
        '## Contents',
        '- [One](#one)',
        '<a id="one"></a>',
        '## First part',
        '[Open it](https://jaybi.uz/#/app/health)',
        '<a id="sub"></a>',
        '### A step',
        '1. First',
        '2. Second',
        '   continues here',
        '',
        '> A note',
        '',
        '| A | B |',
        '| --- | --- |',
        '| 1 | **2** |',
        '<!-- hidden -->',
        '![A picture](images/en/shot.webp)',
      ].join('\n'),
      { locale: 'en', imageSize: () => ({ width: 10, height: 20 }) },
    )
    expect(doc.title).toBe('Guide')
    expect(doc.intro).toEqual([{ t: 'p', v: [{ t: 'text', v: 'Intro text.' }] }])
    expect(doc.sections.map((section) => section.id)).toEqual(['one'])
    expect(doc.sections[0].blocks).toEqual([
      { t: 'open', to: '/app/health', v: [{ t: 'text', v: 'Open it' }] },
      { t: 'h3', id: 'sub', v: [{ t: 'text', v: 'A step' }] },
      { t: 'ol', items: [[{ t: 'text', v: 'First' }], [{ t: 'text', v: 'Second continues here' }]] },
      { t: 'note', v: [[{ t: 'text', v: 'A note' }]] },
      { t: 'table', head: [[{ t: 'text', v: 'A' }], [{ t: 'text', v: 'B' }]], rows: [[[{ t: 'text', v: '1' }], [{ t: 'strong', v: [{ t: 'text', v: '2' }] }]]] },
      { t: 'img', src: 'help/en/shot.webp', alt: 'A picture', width: 10, height: 20 },
    ])
    expect(doc.sections[0].text).toContain('Second continues here')
  })

  it('refuses pictures from another language or outside the images folder', () => {
    expect(() => parseGuide('![x](images/ru/a.webp)', { locale: 'en' })).toThrow(/another language/)
    expect(() => parseGuide('![x](https://example.org/a.webp)', { locale: 'en' })).toThrow(/images/)
    expect(() => parseGuide('![x](../images/en/../../a.webp)', { locale: 'en' })).toThrow(/images/)
  })

  it('reads the size of WebP and PNG files from their headers', () => {
    const png = new Uint8Array(24)
    png.set([0x89, 0x50, 0x4e, 0x47], 0)
    new DataView(png.buffer).setUint32(16, 1440)
    new DataView(png.buffer).setUint32(20, 900)
    expect(imageSize(png)).toEqual({ width: 1440, height: 900 })
    const sample = readdirSync(resolve(IMAGES, 'en')).find((name) => name.endsWith('.webp'))
    if (sample) expect(imageSize(readFileSync(resolve(IMAGES, 'en', sample)))?.width).toBeGreaterThan(100)
    expect(imageSize(new Uint8Array(40))).toBeNull()
  })
})

describe('user guides', () => {
  const docs = Object.fromEntries(HELP_LOCALES.map((locale) => [locale, parse(locale)])) as Record<HelpLocale, HelpDoc>

  it.each(HELP_LOCALES)('%s links to the other guides at the top and has a contents list', (locale) => {
    const text = read(locale)
    const head = text.split('\n').slice(0, 4).join('\n')
    for (const other of HELP_LOCALES.filter((item) => item !== locale)) {
      const target = locale === 'en' ? `${other}/user-guide.md` : other === 'en' ? '../user-guide.md' : `../${other}/user-guide.md`
      expect(head, `${locale} → ${other}`).toContain(`(${target})`)
    }
    expect(text).toContain('<a id="contents"></a>')
  })

  it.each(HELP_LOCALES)('%s has every section the app links to, and its links and pictures resolve', (locale) => {
    const doc = docs[locale]
    const ids = anchors(doc)
    for (const id of CONTEXT_SECTIONS) expect(ids.has(id), `${locale}: section ${id}`).toBe(true)
    const broken: string[] = []
    const routes: string[] = []
    for (const block of blocks(doc)) {
      if (block.t === 'img') {
        expect(block.alt.trim(), `${locale}: ${block.src} needs alt text`).not.toBe('')
        if (existsSync(resolve(IMAGES, block.src.replace(/^help\//, '')))) expect(block.width, `${locale}: ${block.src} size`).toBeGreaterThan(0)
        else broken.push(block.src)
      }
      if (block.t === 'open') routes.push(block.to)
      for (const nodes of inlines(block)) {
        walk(nodes, (node) => {
          if (node.t === 'section' && !ids.has(node.id)) broken.push(`#${node.id}`)
          if (node.t === 'route') routes.push(node.to)
        })
        const text = inlineText(nodes)
        expect(text, `${locale}: leftover markdown in "${text.slice(0, 60)}"`).not.toMatch(/\*\*|\]\(|!\[/)
      }
    }
    expect(broken, locale).toEqual([])
    expect(routes.length, `${locale}: open buttons`).toBeGreaterThan(5)
    const contents = read(locale).split('<a id="contents"></a>')[1]?.split(/\n<a id=/)[0] ?? ''
    for (const match of contents.matchAll(/\]\(#([^)]+)\)/g)) expect(ids.has(match[1]), `${locale}: contents → #${match[1]}`).toBe(true)
  })

  it.each(HELP_LOCALES)('%s shows many of its own screenshots', (locale) => {
    const pictures = blocks(docs[locale]).filter((block) => block.t === 'img')
    expect(pictures.length).toBeGreaterThanOrEqual(40)
    for (const picture of pictures) expect(picture.t === 'img' && picture.src.startsWith(`help/${locale}/`)).toBe(true)
  })

  it('keeps the same sections and pictures in every language', () => {
    const shape = (doc: HelpDoc) => ({
      sections: doc.sections.map((section) => section.id),
      anchors: [...anchors(doc)].sort(),
      pictures: blocks(doc).flatMap((block) => (block.t === 'img' ? [block.src.replace(/^help\/[^/]+\//, '')] : [])),
    })
    const english = shape(docs.en)
    for (const locale of HELP_LOCALES.filter((item) => item !== 'en')) expect(shape(docs[locale]), locale).toEqual(english)
  })

  it('has a screenshot in every language for every English one, and nothing unused', () => {
    const english = readdirSync(resolve(IMAGES, 'en')).sort()
    const used = new Set(blocks(docs.en).flatMap((block) => (block.t === 'img' ? [block.src.replace(/^help\/en\//, '')] : [])))
    expect(english.filter((name) => !used.has(name))).toEqual([])
    for (const locale of HELP_LOCALES) expect(readdirSync(resolve(IMAGES, locale)).sort(), locale).toEqual(english)
  })

  it('writes Uzbek Latin with the proper oʻ, gʻ and tutuq signs', () => {
    const text = read('uz-Latn')
    expect(text).not.toMatch(/[oOgG][‘'`’]/u)
    expect(text.match(/\p{L}'\p{L}/gu) ?? []).toEqual([])
  })
})
