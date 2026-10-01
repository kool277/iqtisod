import { describe, expect, it } from 'vitest'
import { loginPathFor, returnPath } from '../../src/lib/return-to'

describe('return after sign-in', () => {
  it('accepts app pages with a well-formed query', () => {
    expect(returnPath('/app')).toBe('/app')
    expect(returnPath('/app/transactions')).toBe('/app/transactions')
    expect(returnPath('/app/transactions?group=3')).toBe('/app/transactions?group=3')
    expect(returnPath('/app/safes/3f1c9a2e-77b0?item=12')).toBe('/app/safes/3f1c9a2e-77b0?item=12')
    expect(returnPath('/app/safes/trash/')).toBe('/app/safes/trash/')
  })

  it('refuses anything outside the app pages', () => {
    for (const value of [
      null,
      undefined,
      '',
      '/',
      '/login',
      '/setup',
      '/register?kind=reset',
      '/application',
      '/apps',
      'app/transactions',
      '//evil.com',
      '//evil.com/app',
      '/\\evil.com',
      'https://evil.com/app',
      'javascript:alert(1)',
      '/app/../setup',
      '/app/./users',
      '/app//users',
      '/app/%2e%2e/setup',
      '/app/<script>',
      '/app/transactions?next=https://evil.com',
      '/app/transactions?a=%zz',
      '/app/transactions#x',
      `/app/${'a'.repeat(600)}`,
    ]) {
      expect(returnPath(value), String(value)).toBeNull()
    }
  })

  it('builds the sign-in route with the page to come back to', () => {
    expect(loginPathFor('/app/transactions', '?group=3')).toBe('/login?next=%2Fapp%2Ftransactions%3Fgroup%3D3')
    expect(new URLSearchParams(loginPathFor('/app/groups', '').split('?')[1]).get('next')).toBe('/app/groups')
    expect(loginPathFor('/app', '')).toBe('/login')
    expect(loginPathFor('/app/transactions', '?x=<y>')).toBe('/login')
    expect(loginPathFor('/setup', '')).toBe('/login')
  })
})
