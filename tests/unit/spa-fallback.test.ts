import { describe, expect, it } from 'vitest'
import { FALLBACK_HOME, fallbackTarget } from '../../src/lib/spa-fallback'

function target(pathname: string, search = '', hash = ''): string | null {
  return fallbackTarget({ pathname, search, hash })
}

/** What a browser would actually open for the target, resolved against the live site. */
function landsOn(result: string | null): URL {
  if (result == null) throw new Error('no redirect')
  return new URL(result, 'https://jaybi.uz/app/transactions')
}

describe('404 fallback', () => {
  it('turns path-style addresses into hash routes', () => {
    expect(target('/app/transactions')).toBe('/#/app/transactions')
    expect(target('/app/groups')).toBe('/#/app/groups')
    expect(target('/app')).toBe('/#/app')
    expect(target('/register')).toBe('/#/register')
    expect(target('/login')).toBe('/#/login')
    expect(target('/app/safes/trash')).toBe('/#/app/safes/trash')
    expect(target('/app/safes/3f1c9a2e-77b0-4d1e-9a43-0c5d2e8b9f10')).toBe('/#/app/safes/3f1c9a2e-77b0-4d1e-9a43-0c5d2e8b9f10')
  })

  it('drops a trailing slash', () => {
    expect(target('/app/transactions/')).toBe('/#/app/transactions')
    expect(target('/app/')).toBe('/#/app')
  })

  it('keeps a well-formed query', () => {
    expect(target('/app/transactions', '?group=12')).toBe('/#/app/transactions?group=12')
    expect(target('/register', '?kind=reset')).toBe('/#/register?kind=reset')
    expect(target('/app/safes/abc', '?item=7&x=a%20b')).toBe('/#/app/safes/abc?item=7&x=a%20b')
  })

  it('drops a query it cannot vouch for but still opens the page', () => {
    expect(target('/app/transactions', '?group=<script>')).toBe('/#/app/transactions')
    expect(target('/app/transactions', '?next=//evil.com')).toBe('/#/app/transactions')
    expect(target('/app/transactions', '?a=%zz')).toBe('/#/app/transactions')
    expect(target('/app/transactions', `?group=${'1'.repeat(600)}`)).toBe('/#/app/transactions')
    expect(target('/app/transactions', '?')).toBe('/#/app/transactions')
  })

  it('strips the old github.io base path', () => {
    expect(target('/iqtisod')).toBe(FALLBACK_HOME)
    expect(target('/iqtisod/')).toBe(FALLBACK_HOME)
    expect(target('/iqtisod/index.html')).toBe(FALLBACK_HOME)
    expect(target('/iqtisod/app/transactions', '?group=4')).toBe('/#/app/transactions?group=4')
    expect(target('/iqtisod/register')).toBe('/#/register')
    expect(target('/iqtisodx/app')).toBe('/#/iqtisodx/app')
  })

  it('follows a hash route left on the old base path', () => {
    expect(target('/iqtisod/', '', '#/app/groups')).toBe('/#/app/groups')
    expect(target('/iqtisod/', '', '#/app/transactions?group=9')).toBe('/#/app/transactions?group=9')
    expect(target('/iqtisod/index.html', '', '#/app/backup')).toBe('/#/app/backup')
    expect(target('/iqtisod/', '', '#/app/../../evil')).toBe(FALLBACK_HOME)
  })

  it('ignores a fragment that is not a route', () => {
    expect(target('/app/transactions', '', '#content')).toBe('/#/app/transactions')
    expect(target('/iqtisod/', '', '#content')).toBe(FALLBACK_HOME)
    expect(target('/app/transactions', '', '#/app/users')).toBe('/#/app/transactions')
  })

  it('leaves missing files alone instead of opening the app', () => {
    expect(target('/assets/index-old.js')).toBeNull()
    expect(target('/assets/')).toBeNull()
    expect(target('/rates/2026-09-30.json')).toBeNull()
    expect(target('/rates')).toBeNull()
    expect(target('/favicon.ico')).toBeNull()
    expect(target('/iqtisod/version.json')).toBeNull()
    expect(target('/manifest.webmanifest')).toBeNull()
  })

  it('never leaves the origin, whatever the address holds', () => {
    const hostile = [
      ['//evil.com'],
      ['//evil.com/app'],
      ['/\\evil.com'],
      ['/\\/evil.com'],
      ['/%2F%2Fevil.com'],
      ['/%5Cevil.com'],
      ['/%2fevil.com/app'],
      ['javascript:alert(1)'],
      ['/javascript:alert(1)'],
      ['/app/javascript%3Aalert(1)'],
      ['https://evil.com/app'],
      ['/https://evil.com'],
      ['/app/%0d%0aSet-Cookie:x=1'],
      ['/app/%00'],
      ['/app/%E2%80%AEtxt'],
      ['/app/../../etc/passwd'],
      ['/app/%2e%2e/%2e%2e/admin'],
      ['/app/./users'],
      ['/app//users'],
      ['/app/<img src=x>'],
      ['/app/%3Cscript%3E'],
      ['/app/%'],
      ['/app/%E0%A4%A'],
      ['/app/users', '', '#//evil.com'],
      ['/', '', '#/\\evil.com'],
      ['/iqtisod/', '', '#//evil.com'],
      ['/iqtisod/', '', '#/app?next=https://evil.com'],
    ] as const
    for (const [pathname, search = '', hash = ''] of hostile) {
      const result = target(pathname, search, hash)
      if (result == null) continue
      expect(result.startsWith('/#/'), `${pathname}${hash} -> ${result}`).toBe(true)
      const url = landsOn(result)
      expect(url.origin, `${pathname}${hash}`).toBe('https://jaybi.uz')
      expect(url.pathname, `${pathname}${hash}`).toBe('/')
      expect(url.hash).toMatch(/^#\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?(?:\?(?:[A-Za-z0-9._~+=&-]|%[0-9A-Fa-f]{2})+)?$/)
    }
  })

  it('sends malformed paths home', () => {
    expect(target('//evil.com')).toBe(FALLBACK_HOME)
    expect(target('/\\evil.com')).toBe(FALLBACK_HOME)
    expect(target('/%2F%2Fevil.com')).toBe(FALLBACK_HOME)
    expect(target('javascript:alert(1)')).toBe(FALLBACK_HOME)
    expect(target('/app/../users')).toBe(FALLBACK_HOME)
    expect(target('/app/%2e%2e/users')).toBe(FALLBACK_HOME)
    expect(target('/app/%')).toBe(FALLBACK_HOME)
    expect(target('/app/caf%C3%A9')).toBe(FALLBACK_HOME)
    expect(target('/', '', '#//evil.com')).toBe(FALLBACK_HOME)
    expect(target('/iqtisod/', '', '#/app?next=https://evil.com')).toBe('/#/app')
  })

  it('caps the length it will carry over', () => {
    expect(target(`/app/${'a'.repeat(507)}`)).toBe(`/#/app/${'a'.repeat(507)}`)
    expect(target(`/app/${'a'.repeat(508)}`)).toBe(FALLBACK_HOME)
    expect(target(`/${'a/'.repeat(5000)}`)).toBe(FALLBACK_HOME)
    expect(target('/iqtisod/', '', `#/app/${'a'.repeat(4000)}`)).toBe(FALLBACK_HOME)
  })

  it('decodes once, so an encoded but harmless segment still works', () => {
    expect(target('/app/%74ransactions')).toBe('/#/app/transactions')
    expect(target('/app/%2574ransactions')).toBe(FALLBACK_HOME)
  })
})
