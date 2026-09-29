import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { readVault, writeVault, type VaultRecord } from '../db/storage'
import type { OpenVault, SessionUser } from '../domain/types'
import { AuthError } from '../domain/errors'
import { createVault, sealVault, unlockVault, type SetupInput } from '../services/auth.service'

type Status = 'checking' | 'setup' | 'locked' | 'ready' | 'error'
type SaveState = 'saved' | 'saving' | 'dirty' | 'error'

type VaultApi = {
  status: Status
  bootError: string | null
  user: SessionUser | null
  currency: string
  vaultName: string
  revision: number
  saveState: SaveState
  setup: (input: SetupInput) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  lock: () => Promise<void>
  importBackup: (record: VaultRecord) => Promise<void>
  exportBackup: () => Promise<VaultRecord>
  run: <T>(fn: (vault: OpenVault) => Promise<T> | T, options?: { dirty?: boolean }) => Promise<T>
  query: <T>(fn: (vault: OpenVault) => T) => T
}

const VaultContext = createContext<VaultApi | null>(null)

function snapshotUser(user: SessionUser): SessionUser {
  return { ...user, permissions: [...user.permissions] }
}

export function VaultProvider({ children }: { children: ReactNode }) {
  const vaultRef = useRef<OpenVault | null>(null)
  const dirtyRef = useRef(false)
  const chainRef = useRef(Promise.resolve())
  const debounceRef = useRef<number | null>(null)
  const [status, setStatus] = useState<Status>('checking')
  const [bootError, setBootError] = useState<string | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [currency, setCurrency] = useState('USD')
  const [vaultName, setVaultName] = useState('Moliya')
  const [revision, setRevision] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')

  const publish = useCallback((vault: OpenVault) => {
    vaultRef.current = vault
    dirtyRef.current = false
    setUser(snapshotUser(vault.user))
    setCurrency(vault.currency)
    setVaultName(vault.vaultName)
    setSaveState('saved')
    setStatus('ready')
  }, [])

  const persistNow = useCallback(async () => {
    const vault = vaultRef.current
    if (!vault || !dirtyRef.current) return
    dirtyRef.current = false
    setSaveState('saving')
    try {
      const record = await sealVault(vault)
      await writeVault(record)
      setSaveState(dirtyRef.current ? 'dirty' : 'saved')
    } catch {
      dirtyRef.current = true
      setSaveState('error')
    }
  }, [])

  const enqueuePersist = useCallback(() => {
    chainRef.current = chainRef.current.then(() => persistNow()).catch(() => undefined)
    return chainRef.current
  }, [persistNow])

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    setSaveState('dirty')
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
      setUser(snapshotUser(vault.user))
      setCurrency(vault.currency)
      setVaultName(vault.vaultName)
      if (options?.dirty) markDirty()
      return result
    },
    [markDirty],
  )

  const query = useCallback(<T,>(fn: (vault: OpenVault) => T): T => {
    const vault = vaultRef.current
    if (!vault) throw new Error('LOCKED')
    return fn(vault)
  }, [])

  const setup = useCallback(
    async (input: SetupInput) => {
      const created = await createVault(input)
      try {
        await writeVault(created.record)
      } catch (error) {
        created.vault.db.close()
        throw error
      }
      publish(created.vault)
    },
    [publish],
  )

  const login = useCallback(
    async (email: string, password: string) => {
      const record = await readVault()
      if (!record) {
        setStatus('setup')
        throw new AuthError()
      }
      const vault = await unlockVault(record, email, password)
      publish(vault)
    },
    [publish],
  )

  const lock = useCallback(async () => {
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    const vault = vaultRef.current
    vaultRef.current = null
    vault?.db.close()
    dirtyRef.current = false
    setUser(null)
    setStatus('locked')
  }, [enqueuePersist])

  const importBackup = useCallback(async (record: VaultRecord) => {
    const current = vaultRef.current
    vaultRef.current = null
    current?.db.close()
    await writeVault(record)
    dirtyRef.current = false
    setUser(null)
    setSaveState('saved')
    setStatus('locked')
  }, [])

  const exportBackup = useCallback(async () => {
    if (!vaultRef.current) throw new Error('LOCKED')
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    const record = await readVault()
    if (!record) throw new Error('MISSING')
    return record
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
        setBootError(error instanceof Error ? error.message : 'sqlite')
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
