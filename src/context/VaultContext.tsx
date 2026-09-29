import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { readVault, readVaultRaw, stampOf, writeVault, type VaultRecord } from '../db/storage'
import { RECORD_VERSION, SCHEMA_VERSION } from '../db/versions'
import type { OpenVault, SessionUser } from '../domain/types'
import { AppError, AuthError, ConflictError, VaultInUseError } from '../domain/errors'
import { requestPersistence } from '../lib/persistence'
import { acquireSessionLock } from '../lib/session-lock'
import type { ParsedBackup } from '../services/backup.service'
import { createVault, sealVault, unlockVault, type SetupInput } from '../services/auth.service'

type Status = 'checking' | 'setup' | 'locked' | 'ready' | 'error'
type SaveState = 'saved' | 'saving' | 'dirty' | 'error' | 'conflict'

type VaultApi = {
  status: Status
  bootError: string | null
  user: SessionUser | null
  currency: string
  vaultName: string
  lastBackupAt: string | null
  revision: number
  saveState: SaveState
  setup: (input: SetupInput) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  lock: () => Promise<void>
  importBackup: (backup: ParsedBackup) => Promise<void>
  exportBackup: () => Promise<VaultRecord>
  run: <T>(fn: (vault: OpenVault) => Promise<T> | T, options?: { dirty?: boolean }) => Promise<T>
  query: <T>(fn: (vault: OpenVault) => T) => T
}

const VaultContext = createContext<VaultApi | null>(null)

function snapshotUser(user: SessionUser): SessionUser {
  return { ...user, permissions: [...user.permissions] }
}

function bootErrorCode(error: unknown): string {
  if (error instanceof AppError) return error.code
  return error instanceof Error ? error.message : 'sqlite'
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const vaultRef = useRef<OpenVault | null>(null)
  const dirtyRef = useRef(false)
  const conflictRef = useRef(false)
  const stampRef = useRef<string | null>(null)
  const archiveRef = useRef<unknown>(null)
  const releaseRef = useRef<(() => void) | null>(null)
  const chainRef = useRef(Promise.resolve())
  const debounceRef = useRef<number | null>(null)
  const [status, setStatus] = useState<Status>('checking')
  const [bootError, setBootError] = useState<string | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [currency, setCurrency] = useState('USD')
  const [vaultName, setVaultName] = useState('Moliya')
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')

  const syncState = useCallback((vault: OpenVault) => {
    setUser(snapshotUser(vault.user))
    setCurrency(vault.currency)
    setVaultName(vault.vaultName)
    setLastBackupAt(vault.lastBackupAt)
  }, [])

  const releaseSession = useCallback(() => {
    releaseRef.current?.()
    releaseRef.current = null
  }, [])

  const publish = useCallback(
    (vault: OpenVault, stamp: string | null) => {
      vaultRef.current = vault
      dirtyRef.current = false
      conflictRef.current = false
      stampRef.current = stamp
      syncState(vault)
      setSaveState('saved')
      setStatus('ready')
      void requestPersistence()
    },
    [syncState],
  )

  const persistNow = useCallback(async () => {
    const vault = vaultRef.current
    if (!vault || !dirtyRef.current || conflictRef.current) return
    dirtyRef.current = false
    setSaveState('saving')
    try {
      const record = await sealVault(vault)
      const archive = archiveRef.current
      await writeVault(record, {
        expectedStamp: stampRef.current,
        archive: archive === null ? undefined : { reason: 'upgrade', raw: archive },
      })
      archiveRef.current = null
      stampRef.current = record.updatedAt
      setSaveState(dirtyRef.current ? 'dirty' : 'saved')
    } catch (error) {
      dirtyRef.current = true
      if (error instanceof ConflictError) {
        conflictRef.current = true
        setSaveState('conflict')
      } else {
        setSaveState('error')
      }
    }
  }, [])

  const enqueuePersist = useCallback(() => {
    chainRef.current = chainRef.current.then(() => persistNow()).catch(() => undefined)
    return chainRef.current
  }, [persistNow])

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    if (!conflictRef.current) setSaveState('dirty')
    setRevision((value) => value + 1)
    if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(() => {
      void enqueuePersist()
    }, 800)
  }, [enqueuePersist])

  const run = useCallback(
    async <T,>(fn: (vault: OpenVault) => Promise<T> | T, options?: { dirty?: boolean }): Promise<T> => {
      const vault = vaultRef.current
      if (!vault) throw new Error('LOCKED')
      const result = await fn(vault)
      syncState(vault)
      if (options?.dirty) markDirty()
      return result
    },
    [markDirty, syncState],
  )

  const query = useCallback(<T,>(fn: (vault: OpenVault) => T): T => {
    const vault = vaultRef.current
    if (!vault) throw new Error('LOCKED')
    return fn(vault)
  }, [])

  const setup = useCallback(
    async (input: SetupInput) => {
      const release = await acquireSessionLock()
      if (!release) throw new VaultInUseError()
      try {
        const created = await createVault(input)
        try {
          await writeVault(created.record, { expectedStamp: null })
        } catch (error) {
          created.vault.db.close()
          throw error
        }
        releaseRef.current = release
        publish(created.vault, created.record.updatedAt)
      } catch (error) {
        release()
        throw error
      }
    },
    [publish],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const loaded = await readVault()
      if (!loaded) {
        setStatus('setup')
        throw new AuthError()
      }
      const release = await acquireSessionLock()
      if (!release) throw new VaultInUseError()
      try {
        const vault = await unlockVault(loaded.record, email, password)
        releaseRef.current = release
        publish(vault, stampOf(loaded.raw))
        if (vault.needsSave) {
          const upgraded = loaded.sourceVersion < RECORD_VERSION || loaded.record.schemaVersion < SCHEMA_VERSION
          archiveRef.current = upgraded ? loaded.raw : null
          vault.needsSave = false
          dirtyRef.current = true
          setSaveState('dirty')
          await enqueuePersist()
        }
      } catch (error) {
        if (releaseRef.current !== release) release()
        throw error
      }
    },
    [publish, enqueuePersist],
  )

  const lock = useCallback(async () => {
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    const vault = vaultRef.current
    vaultRef.current = null
    vault?.db.close()
    dirtyRef.current = false
    archiveRef.current = null
    releaseSession()
    setUser(null)
    setStatus('locked')
  }, [enqueuePersist, releaseSession])

  const importBackup = useCallback(
    async (backup: ParsedBackup) => {
      const current = vaultRef.current
      const existing = await readVaultRaw()
      await writeVault(backup.record, {
        archive: existing === undefined ? undefined : { reason: 'import', raw: existing },
      })
      vaultRef.current = null
      current?.db.close()
      dirtyRef.current = false
      conflictRef.current = false
      archiveRef.current = null
      releaseSession()
      setUser(null)
      setSaveState('saved')
      setStatus('locked')
    },
    [releaseSession],
  )

  const exportBackup = useCallback(async () => {
    if (!vaultRef.current) throw new Error('LOCKED')
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    if (conflictRef.current) throw new ConflictError()
    const loaded = await readVault()
    if (!loaded) throw new Error('MISSING')
    return loaded.record
  }, [enqueuePersist])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const existing = await readVault()
        if (cancelled) return
        setStatus(existing ? 'locked' : 'setup')
      } catch (error) {
        if (cancelled) return
        setBootError(bootErrorCode(error))
        setStatus('error')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    const interval = window.setInterval(() => {
      if (dirtyRef.current) void enqueuePersist()
    }, 5000)
    const flush = () => {
      if (dirtyRef.current) void enqueuePersist()
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [status, enqueuePersist])

  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [])

  const value = useMemo(
    () => ({
      status,
      bootError,
      user,
      currency,
      vaultName,
      lastBackupAt,
      revision,
      saveState,
      setup,
      login,
      lock,
      importBackup,
      exportBackup,
      run,
      query,
    }),
    [
      status,
      bootError,
      user,
      currency,
      vaultName,
      lastBackupAt,
      revision,
      saveState,
      setup,
      login,
      lock,
      importBackup,
      exportBackup,
      run,
      query,
    ],
  )

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

export function useVault(): VaultApi {
  const value = useContext(VaultContext)
  if (!value) throw new Error('Vault provider is missing')
  return value
}
