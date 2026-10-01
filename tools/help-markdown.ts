import type { HelpBlock, HelpDoc, HelpInline, HelpSection } from '../src/help/types.ts'

/**
 * Turns a user guide written in a small Markdown subset into the data the in-app Help renders. Only these forms
 * are understood: `#`, `##`, `###` headings, an `<a id="..."></a>` line naming the next heading, paragraphs,
 * `-` and `1.` lists (no nesting), `>` notes, tables, a picture alone on its line, and inline `**bold**`,
 * `` `code` `` and `[links](...)`. Anything else stays literal text, and React renders it as text.
 */

export const APP_ORIGIN = 'https://jaybi.uz/'
export const HELP_LOCALES = ['en', 'ru', 'uz-Latn', 'uz-Cyrl'] as const
export type HelpLocale = (typeof HELP_LOCALES)[number]

/** Where each guide lives, relative to the repository root. */
export function guidePath(locale: HelpLocale): string {
  return locale === 'en' ? 'docs/user-guide.md' : `docs/${locale}/user-guide.md`
}

const ANCHOR = /^<a id="([a-z0-9][a-z0-9-]*)"><\/a>$/
const IMAGE = /^!\[([^\]]*)\]\(([^)\s]+)\)$/
const IMAGE_PATH = /^(?:\.\.\/)?images\/(en|ru|uz-Latn|uz-Cyrl)\/([a-z0-9][a-z0-9-]*\.(?:webp|png|jpg))$/
const ROUTE = /^\/(?:app(?:\/[A-Za-z0-9._~-]+)*|help|health)(?:\?[A-Za-z0-9._~=&-]*)?$/
const INLINE = /\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g
const LIST_ITEM = /^(-|\d+\.)\s+(.*)$/
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/

export type ImageSize = { width: number; height: number }
export type ParseOptions = { locale: HelpLocale; imageSize?: (src: string) => ImageSize | null }

export function parseInline(text: string): HelpInline[] {
  const out: HelpInline[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) out.push({ t: 'text', v: text.slice(last, index) })
    last = index + match[0].length
    const [, bold, code, label, href] = match
    if (bold !== undefined) out.push({ t: 'strong', v: parseInline(bold) })
    else if (code !== undefined) out.push({ t: 'code', v: code })
    else out.push(link(label, href))
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) })
  return out
}

function link(label: string, href: string): HelpInline {
  const v = parseInline(label)
  if (href.startsWith('#')) return { t: 'section', id: href.slice(1), v }
  if (href.startsWith(`${APP_ORIGIN}#/`)) {
    const to = href.slice(APP_ORIGIN.length + 1)
    if (ROUTE.test(to)) return { t: 'route', to, v }
  }
  if (/^https:\/\/[^\s/]+/.test(href)) return { t: 'external', href, v }
  // Links to other files of the repository (another guide, the admin guide) mean nothing inside the app.
  return { t: 'strong', v }
}

export function inlineText(nodes: readonly HelpInline[]): string {
  return nodes.map((node) => (node.t === 'text' || node.t === 'code' ? node.v : inlineText(node.v))).join('')
}

function blockText(block: HelpBlock): string {
  switch (block.t) {
    case 'p':
    case 'h3':
    case 'open':
      return inlineText(block.v)
    case 'ul':
    case 'ol':
      return block.items.map(inlineText).join(' ')
    case 'note':
      return block.v.map(inlineText).join(' ')
    case 'table':
      return [...block.head, ...block.rows.flat()].map(inlineText).join(' ')
    case 'img':
      return block.alt
  }
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  )
}

type Draft = { id: string; title: string; blocks: HelpBlock[] }

/** Repeated until nothing changes, because removing one comment can join the pieces around it into a new `<!--`. */
function stripComments(text: string): string {
  let out = text
  let previous: string
  do {
    previous = out
    out = out.replace(/<!--[\s\S]*?-->/g, '')
  } while (out !== previous)
  return out
}

export function parseGuide(markdown: string, options: ParseOptions): HelpDoc {
  const lines = stripComments(markdown.replace(/\r\n?/g, '\n')).split('\n')
  let title = ''
  const intro: HelpBlock[] = []
  const sections: Draft[] = []
  let anchor: string | null = null
  let index = 0

  const target = () => (sections.length ? sections[sections.length - 1].blocks : intro)

  while (index < lines.length) {
    const line = lines[index]
    const trimmed = line.trim()
    if (trimmed === '') {
      index += 1
      continue
    }
    const anchorMatch = ANCHOR.exec(trimmed)
    if (anchorMatch) {
      anchor = anchorMatch[1]
      index += 1
      continue
    }
    if (trimmed.startsWith('# ')) {
      title = trimmed.slice(2).trim()
      index += 1
      continue
    }
    if (trimmed.startsWith('## ')) {
      const text = trimmed.slice(3).trim()
      sections.push({ id: anchor ?? slug(text), title: text, blocks: [] })
      anchor = null
      index += 1
      continue
    }
    if (trimmed.startsWith('### ')) {
      const text = trimmed.slice(4).trim()
      target().push({ t: 'h3', id: anchor ?? slug(text), v: parseInline(text) })
      anchor = null
      index += 1
      continue
    }
    const image = IMAGE.exec(trimmed)
    if (image) {
      const [, alt, path] = image
      const file = IMAGE_PATH.exec(path)
      if (!file) throw new Error(`${options.locale}: picture ${path} is not under images/<locale>/`)
      if (file[1] !== options.locale) throw new Error(`${options.locale}: picture ${path} belongs to another language`)
      const src = `help/${file[1]}/${file[2]}`
      const size = options.imageSize?.(src) ?? null
      target().push({ t: 'img', src, alt, ...(size ? { width: size.width, height: size.height } : {}) })
      index += 1
      continue
    }
    if (trimmed.startsWith('>')) {
      const paragraphs: string[][] = [[]]
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        const content = lines[index].trim().replace(/^>\s?/, '')
        if (content === '') paragraphs.push([])
        else paragraphs[paragraphs.length - 1].push(content)
        index += 1
      }
      target().push({ t: 'note', v: paragraphs.filter((part) => part.length).map((part) => parseInline(part.join(' '))) })
      continue
    }
    if (trimmed.startsWith('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1].trim())) {
      const head = splitRow(trimmed).map(parseInline)
      index += 2
      const rows: HelpInline[][][] = []
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitRow(lines[index]).map(parseInline))
        index += 1
      }
      target().push({ t: 'table', head, rows })
      continue
    }
    const item = LIST_ITEM.exec(trimmed)
    if (item) {
      const ordered = item[1] !== '-'
      const items: string[] = []
      while (index < lines.length) {
        const current = lines[index]
        const match = LIST_ITEM.exec(current.trim())
        if (match && (match[1] !== '-') === ordered && !/^\s{2,}/.test(current)) {
          items.push(match[2])
        } else if (current.trim() !== '' && /^\s{2,}/.test(current) && items.length) {
          items[items.length - 1] += ` ${current.trim()}`
        } else {
          break
        }
        index += 1
      }
      target().push({ t: ordered ? 'ol' : 'ul', items: items.map(parseInline) })
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length) {
      const current = lines[index].trim()
      if (current === '' || current.startsWith('#') || current.startsWith('>') || current.startsWith('|') || IMAGE.test(current) || ANCHOR.test(current) || LIST_ITEM.test(current)) break
      paragraph.push(current)
      index += 1
    }
    const inline = parseInline(paragraph.join(' '))
    const only = inline.filter((node) => !(node.t === 'text' && node.v.trim() === ''))
    if (only.length === 1 && only[0].t === 'route') target().push({ t: 'open', to: only[0].to, v: only[0].v })
    else target().push({ t: 'p', v: inline })
  }

  return {
    locale: options.locale,
    title,
    intro: intro.filter((block) => !isLanguageLine(block)),
    sections: sections
      .filter((section) => section.id !== 'contents')
      .map(
        (section): HelpSection => ({
          ...section,
          text: [section.title, ...section.blocks.map(blockText)].join(' '),
        }),
      ),
  }
}

/** The line at the top of each guide that links to the other languages; the app has its own language switch. */
function isLanguageLine(block: HelpBlock): boolean {
  if (block.t !== 'p') return false
  const links = block.v.filter((node) => node.t !== 'text')
  return links.length > 0 && block.v.every((node) => node.t === 'strong' || (node.t === 'text' && /^[\s|·•]*$/.test(node.v)))
}

/** Width and height of a WebP or PNG file, from its header. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG') return { width: view.getUint32(16), height: view.getUint32(20) }
  if (bytes.length < 30 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP') return null
  const chunk = ascii(12, 4)
  if (chunk === 'VP8 ') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
  if (chunk === 'VP8L') {
    const bits = view.getUint32(21, true)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    const u24 = (offset: number) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
    return { width: u24(24) + 1, height: u24(27) + 1 }
  }
  return null
}
