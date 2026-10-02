/**
 * The in-app guide, built from docs/<locale>/user-guide.md at build time. It is plain data rendered by React
 * components, so no HTML or Markdown ever reaches the DOM as markup.
 */
export type HelpInline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: HelpInline[] }
  | { t: 'code'; v: string }
  /** A link to another section of the guide. */
  | { t: 'section'; id: string; v: HelpInline[] }
  /** A link to a screen of the app, written as https://jaybi.uz/#/app/... in the Markdown. */
  | { t: 'route'; to: string; v: HelpInline[] }
  | { t: 'external'; href: string; v: HelpInline[] }

export type HelpBlock =
  | { t: 'p'; v: HelpInline[] }
  | { t: 'h3'; id: string; v: HelpInline[] }
  | { t: 'ul'; items: HelpInline[][] }
  | { t: 'ol'; items: HelpInline[][] }
  /** `src` is relative to the site root, for example `help/en/dashboard.webp`. */
  | { t: 'img'; src: string; alt: string; width?: number; height?: number }
  | { t: 'note'; v: HelpInline[][] }
  | { t: 'table'; head: HelpInline[][]; rows: HelpInline[][][] }
  /** A paragraph that is only a link to an app screen: shown as a button. */
  | { t: 'open'; to: string; v: HelpInline[] }

export type HelpSection = {
  id: string
  title: string
  blocks: HelpBlock[]
  /** Every word of the section, for search. */
  text: string
}

export type HelpDoc = {
  locale: string
  title: string
  intro: HelpBlock[]
  sections: HelpSection[]
}
