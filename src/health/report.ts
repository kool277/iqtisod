import { HEALTH_GROUPS, summarize, type HealthResult } from './model'

export type ReportContext = {
  appName: string
  version: string
  commit: string
  locale: string
  createdAt: string
  /** Browser and platform from the user agent, without anything that names a person. */
  agent: string
  signedIn: boolean
  /** Translates a check id to its title in the current language. */
  title: (result: HealthResult) => string
  /** Translates a fact key to its label in the current language. */
  label: (key: string) => string
}

const MARK: Record<HealthResult['status'], string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', info: 'INFO' }
const EMAIL = /[^\s@]+@[^\s@]+/g

/** Keeps only the product tokens of a user agent, such as "Chrome/140.0" and "Mac OS X 15_6". */
export function shortAgent(userAgent: string): string {
  const products = [...userAgent.matchAll(/\b(Firefox|Edg|OPR|YaBrowser|Chrome|CriOS|FxiOS|Version|Safari)\/(\d+(?:\.\d+)?)/g)].map(([, name, version]) => `${name}/${version}`)
  const platform = /\(([^)]*)\)/.exec(userAgent)?.[1]
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => /Windows|Mac OS|Android|iPhone|iPad|Linux|CrOS/.test(part))
  return [...new Set(products)].slice(0, 3).join(' ') + (platform ? ` (${platform})` : '')
}

/**
 * A plain-text summary to paste into a support message. It holds the app version, the browser, and each check's
 * status and facts. Facts are counts, sizes, versions and dates by design; anything that looks like an email is
 * removed as a second line of defence.
 */
export function healthReport(results: readonly HealthResult[], context: ReportContext): string {
  const summary = summarize(results)
  const lines = [
    `${context.appName} health report`,
    `Version: ${context.version} (${context.commit})`,
    `Created: ${context.createdAt}`,
    `Browser: ${context.agent || 'unknown'}`,
    `Language: ${context.locale}`,
    `Signed in: ${context.signedIn ? 'yes' : 'no'}`,
    `Summary: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail, ${summary.info} info`,
  ]
  for (const group of HEALTH_GROUPS) {
    const items = results.filter((item) => item.group === group)
    if (items.length === 0) continue
    lines.push('', `## ${group}`)
    for (const item of items) {
      const facts = Object.entries(item.facts ?? {})
        .map(([key, value]) => `${context.label(key)}=${value}`)
        .join('; ')
      lines.push(`[${MARK[item.status]}] ${item.id}.${item.detail} - ${context.title(item)}${item.adminOnly ? ' (admin)' : ''}${facts ? ` | ${facts}` : ''}`)
    }
  }
  return `${lines.join('\n').replace(EMAIL, '[removed]')}\n`
}
