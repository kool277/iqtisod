import type { Page } from '@playwright/test'

/** Collects Content Security Policy and Trusted Types violations. The policy exists only in the production build. */
export async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const lines: string[] = []
  page.on('console', (message) => lines.push(message.text()))
  page.on('pageerror', (error) => lines.push(error.message))
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __violations: string[] }).__violations = seen
    document.addEventListener('securitypolicyviolation', (event) => seen.push(`${event.effectiveDirective} ${event.blockedURI}`))
  })
  return async () => [
    ...lines.filter((line) => /Content Security Policy|Trusted Type|Refused to/i.test(line)),
    ...(await page.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])),
  ]
}
