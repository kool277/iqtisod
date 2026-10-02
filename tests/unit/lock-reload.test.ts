import { describe, expect, it } from 'vitest'
import { LOCK_NOTICE_KEY, clearLockNotice, lockUrl, peekLockNotice, rememberLockNotice } from '../../src/lib/lock-reload'

class MemoryStorage {
  readonly map = new Map<string, string>()
  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }
  removeItem(key: string): void {
    this.map.delete(key)
  }
}

const where = (hash: string) => ({ pathname: '/', search: '', hash })

describe('lockUrl', () => {
  it('sends an idle lock to sign-in with a way back to the open page', () => {
    expect(lockUrl(where('#/app/transactions?group=1'), 'idle')).toBe(`/#/login?next=${encodeURIComponent('/app/transactions?group=1')}`)
    expect(lockUrl({ pathname: '/jaybi/', search: '?v=2', hash: '#/app/safes' }, 'idle')).toBe(`/jaybi/?v=2#/login?next=${encodeURIComponent('/app/safes')}`)
  })

  it('sends Lock, the app home and anything outside /app to plain sign-in', () => {
    expect(lockUrl(where('#/app/transactions'), 'manual')).toBe('/#/login')
    expect(lockUrl(where('#/app'), 'idle')).toBe('/#/login')
    expect(lockUrl(where('#/setup'), 'idle')).toBe('/#/login')
    expect(lockUrl(where(''), 'idle')).toBe('/#/login')
    expect(lockUrl(where('#/app/../setup'), 'idle')).toBe('/#/login')
  })
})

describe('lock notice', () => {
  it('survives the reload only for idle locks, and is cleared once read', () => {
    const storage = new MemoryStorage()
    rememberLockNotice('idle', storage)
    expect(storage.getItem(LOCK_NOTICE_KEY)).toBe('idle')
    expect(peekLockNotice(storage)).toBe('idle')
    clearLockNotice(storage)
    expect(peekLockNotice(storage)).toBeNull()
    rememberLockNotice('idle', storage)
    rememberLockNotice('manual', storage)
    expect(peekLockNotice(storage)).toBeNull()
    storage.setItem(LOCK_NOTICE_KEY, 'something else')
    expect(peekLockNotice(storage)).toBeNull()
  })

  it('tolerates missing or failing session storage', () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error('SecurityError')
      },
      setItem: () => {
        throw new Error('SecurityError')
      },
      removeItem: () => {
        throw new Error('SecurityError')
      },
    }
    expect(() => rememberLockNotice('idle', broken)).not.toThrow()
    expect(peekLockNotice(broken)).toBeNull()
    expect(() => clearLockNotice(broken)).not.toThrow()
    expect(peekLockNotice(null)).toBeNull()
  })
})
