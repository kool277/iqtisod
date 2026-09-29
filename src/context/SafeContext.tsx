import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SafeError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
import { clearCopiedSecret } from '../lib/clipboard'
import type { SafeKeyring } from '../services/safe.service'
import { useVault } from './VaultContext'

export type SafeLockReason = 'manual' | 'idle'

type SafeApi = {
  keyring: SafeKeyring | null
  version: number
  previousUnlockAt: string | null
  lockReason: SafeLockReason | null
  adopt: (keyring: SafeKeyring, previousUnlockAt: string | null) => void
  lock: (reason?: SafeLockReason) => void
  refresh: () => void
  withKeyring: <T>(fn: (vault: OpenVault, keyring: SafeKeyring) => Promise<T> | T, options?: { dirty?: boolean }) => Promise<T>
}

const HIDDEN_LOCK_MS = 60_000
const CHECK_MS = 5_000
const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

const SafeContext = createContext<SafeApi | null>(null)

export function SafeProvider({ children }: { children: ReactNode }) {
  const { run, user } = useVault()
  const keyringRef = useRef<SafeKeyring | null>(null)
  const activityRef = useRef(Date.now())
  const hiddenAtRef = useRef<number | null>(null)
  const [keyring, setKeyring] = useState<SafeKeyring | null>(null)
  const [version, setVersion] = useState(0)
  const [previousUnlockAt, setPreviousUnlockAt] = useState<string | null>(null)
  const [lockReason, setLockReason] = useState<SafeLockReason | null>(null)

  const lock = useCallback((reason: SafeLockReason = 'manual') => {
    if (!keyringRef.current) return
    keyringRef.current.openSafes.clear()
    keyringRef.current = null
    clearCopiedSecret()
    setKeyring(null)
    setPreviousUnlockAt(null)
    setLockReason(reason)
    setVersion((value) => value + 1)
  }, [])

  const adopt = useCallback((next: SafeKeyring, previous: string | null) => {
    keyringRef.current = next
    activityRef.current = Date.now()
    setKeyring(next)
    setPreviousUnlockAt(previous)
    setLockReason(null)
    setVersion((value) => value + 1)
  }, [])

  const refresh = useCallback(() => setVersion((value) => value + 1), [])

  const withKeyring = useCallback(
    async <T,>(fn: (vault: OpenVault, keyring: SafeKeyring) => Promise<T> | T, options?: { dirty?: boolean }): Promise<T> => {
      const current = keyringRef.current
      if (!current) throw new SafeError('SAFES_LOCKED')
      activityRef.current = Date.now()
      try {
        return await run((vault) => fn(vault, current), options)
      } catch (error) {
        if (error instanceof SafeError && error.code === 'SAFES_LOCKED') lock()
        throw error
      } finally {
        if (options?.dirty) setVersion((value) => value + 1)
      }
    },
    [run, lock],
  )

  const userId = user?.id ?? null
  const mustChange = user?.mustChangePassword === true
  useEffect(() => {
    if (keyringRef.current && (keyringRef.current.userId !== userId || mustChange)) lock()
  }, [userId, mustChange, lock])

  useEffect(() => {
    if (!keyring) return
    const idleMs = keyring.meta.autoLockMinutes * 60_000
    const touch = () => {
      activityRef.current = Date.now()
    }
    const check = () => {
      const now = Date.now()
      const hiddenAt = hiddenAtRef.current
      if (now - activityRef.current >= idleMs || (hiddenAt !== null && now - hiddenAt >= HIDDEN_LOCK_MS)) lock('idle')
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAtRef.current = Date.now()
        return
      }
      check()
      hiddenAtRef.current = null
      touch()
    }
    const onPageHide = () => lock('idle')
    for (const name of ACTIVITY_EVENTS) window.addEventListener(name, touch, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    const interval = window.setInterval(check, CHECK_MS)
    return () => {
      for (const name of ACTIVITY_EVENTS) window.removeEventListener(name, touch)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.clearInterval(interval)
    }
  }, [keyring, version, lock])

  useEffect(
    () => () => {
      keyringRef.current?.openSafes.clear()
      keyringRef.current = null
      clearCopiedSecret()
    },
    [],
  )

  const value = useMemo(
    () => ({ keyring, version, previousUnlockAt, lockReason, adopt, lock, refresh, withKeyring }),
    [keyring, version, previousUnlockAt, lockReason, adopt, lock, refresh, withKeyring],
  )
  return <SafeContext.Provider value={value}>{children}</SafeContext.Provider>
}

export function useSafes(): SafeApi {
  const value = useContext(SafeContext)
  if (!value) throw new Error('Safe provider is missing')
  return value
}
