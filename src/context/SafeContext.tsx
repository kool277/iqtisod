import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SafeError } from '../domain/errors'
import type { OpenVault } from '../domain/types'
import { createSafeSession } from '../lib/safe-session'
import type { SafeKeyring } from '../services/safe.service'
import { useVault } from './VaultContext'

type SafeApi = {
  keyring: SafeKeyring | null
  version: number
  previousUnlockAt: string | null
  adopt: (keyring: SafeKeyring, previousUnlockAt: string | null) => void
  lock: () => void
  refresh: () => void
  withKeyring: <T>(fn: (vault: OpenVault, keyring: SafeKeyring) => Promise<T> | T, options?: { dirty?: boolean }) => Promise<T>
}

const SafeContext = createContext<SafeApi | null>(null)

/** Safes lock with the vault, so the vault's idle lock (Account → Lock automatically) is also theirs. */
export function SafeProvider({ children }: { children: ReactNode }) {
  const { run, user } = useVault()
  const [session] = useState(createSafeSession)
  const [keyring, setKeyring] = useState<SafeKeyring | null>(null)
  const [version, setVersion] = useState(0)
  const [previousUnlockAt, setPreviousUnlockAt] = useState<string | null>(null)

  const afterLock = useCallback(() => {
    setKeyring(null)
    setPreviousUnlockAt(null)
    setVersion((value) => value + 1)
  }, [])

  const lock = useCallback(() => {
    if (session.lock()) afterLock()
  }, [session, afterLock])

  const adopt = useCallback(
    (next: SafeKeyring, previous: string | null) => {
      session.adopt(next)
      setKeyring(next)
      setPreviousUnlockAt(previous)
      setVersion((value) => value + 1)
    },
    [session],
  )

  const refresh = useCallback(() => setVersion((value) => value + 1), [])

  const withKeyring = useCallback(
    async <T,>(fn: (vault: OpenVault, keyring: SafeKeyring) => Promise<T> | T, options?: { dirty?: boolean }): Promise<T> => {
      const current = session.keyring
      if (!current) throw new SafeError('SAFES_LOCKED')
      try {
        return await run((vault) => fn(vault, current), options)
      } catch (error) {
        if (error instanceof SafeError && error.code === 'SAFES_LOCKED') lock()
        throw error
      } finally {
        if (options?.dirty) setVersion((value) => value + 1)
      }
    },
    [session, run, lock],
  )

  const userId = user?.id ?? null
  const mustChange = user?.mustChangePassword === true
  useEffect(() => {
    if (session.follow(userId, mustChange)) afterLock()
  }, [session, userId, mustChange, afterLock])

  useEffect(() => {
    if (!keyring) return
    window.addEventListener('pagehide', lock)
    return () => window.removeEventListener('pagehide', lock)
  }, [keyring, lock])

  useEffect(() => () => void session.lock(), [session])

  const value = useMemo(
    () => ({ keyring, version, previousUnlockAt, adopt, lock, refresh, withKeyring }),
    [keyring, version, previousUnlockAt, adopt, lock, refresh, withKeyring],
  )
  return <SafeContext.Provider value={value}>{children}</SafeContext.Provider>
}

export function useSafes(): SafeApi {
  const value = useContext(SafeContext)
  if (!value) throw new Error('Safe provider is missing')
  return value
}
