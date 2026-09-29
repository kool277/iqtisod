import { afterEach, describe, expect, it } from 'vitest'
import { currentHostname, isNewAddress, isOldAddress, moveNoticeKind, setHostnameSource } from '../../src/lib/origin-move'

afterEach(() => setHostnameSource())

describe('origin move', () => {
  it('recognises only the old GitHub Pages host as the old address', () => {
    expect(isOldAddress('kool277.github.io')).toBe(true)
    expect(isOldAddress('KOOL277.github.io.')).toBe(true)
    for (const host of ['jaybi.uz', 'www.jaybi.uz', 'localhost', '127.0.0.1', 'other.github.io', 'kool277.github.io.evil.test', '']) {
      expect(isOldAddress(host), host).toBe(false)
    }
  })

  it('recognises jaybi.uz and www.jaybi.uz as the new address', () => {
    expect(isNewAddress('jaybi.uz')).toBe(true)
    expect(isNewAddress('www.jaybi.uz')).toBe(true)
    expect(isNewAddress('JAYBI.UZ.')).toBe(true)
    for (const host of ['kool277.github.io', 'localhost', 'jaybi.uz.evil.test', 'evil-jaybi.uz', 'a.jaybi.uz']) {
      expect(isNewAddress(host), host).toBe(false)
    }
  })

  it('reads the hostname from an injected source', () => {
    setHostnameSource(() => 'Kool277.GitHub.io')
    expect(currentHostname()).toBe('kool277.github.io')
    expect(isOldAddress()).toBe(true)
    expect(isNewAddress()).toBe(false)
    setHostnameSource(() => 'jaybi.uz')
    expect(isOldAddress()).toBe(false)
    expect(isNewAddress()).toBe(true)
  })

  it('falls back to an empty hostname without a window', () => {
    setHostnameSource()
    expect(currentHostname()).toBe('')
    expect(isOldAddress()).toBe(false)
  })

  it('picks the notice for each vault status on the old address only', () => {
    const old = 'kool277.github.io'
    expect(moveNoticeKind(old, 'setup', false)).toBe('setup')
    expect(moveNoticeKind(old, 'locked', false)).toBe('signIn')
    expect(moveNoticeKind(old, 'challenge', false)).toBe('signIn')
    expect(moveNoticeKind(old, 'ready', true)).toBe('backup')
    expect(moveNoticeKind(old, 'ready', false)).toBe('askAdmin')
    expect(moveNoticeKind(old, 'checking', true)).toBeNull()
    expect(moveNoticeKind(old, 'error', true)).toBeNull()
    for (const host of ['jaybi.uz', 'localhost']) {
      for (const status of ['setup', 'locked', 'challenge', 'ready']) expect(moveNoticeKind(host, status, true)).toBeNull()
    }
  })
})
