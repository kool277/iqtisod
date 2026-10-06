import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { auditHead, type AuditHead } from '../db/audit-chain'
import { encodeStoredRecord } from '../db/envelope'
import { readVault, readVaultRaw, stampOf, stripArchivedGrants, writeVault, type LoadedVault, type VaultRecord } from '../db/storage'
import { RECORD_VERSION, SCHEMA_VERSION } from '../db/versions'
import type { OpenVault, SessionUser } from '../domain/types'
import { AppError, AuthError, ConflictError, ForbiddenError, ValidationError, VaultInUseError } from '../domain/errors'
import { observeClock } from '../lib/device-clock'
import { readIdleMinutes, storeIdleMinutes, watchIdle, type IdleMinutes } from '../lib/idle'
import { advanceAuditMark, readAuditMark, resetAuditMark } from '../lib/audit-mark'
import { LIMITS } from '../lib/limits'
import { clearLockNotice, lockUrl, peekLockNotice, rememberLockNotice } from '../lib/lock-reload'
import { passwordProblem } from '../lib/password-policy'
import { requestPersistence } from '../lib/persistence'
import { acquireSessionLock } from '../lib/session-lock'
import { ThrottledError, createThrottle, indexedDbThrottleMirror, type ThrottleScope } from '../lib/throttle'
import { Permission, canUser } from '../rbac'
import { acknowledgeAuditWarning, checkAuditLog, writeAudit, type AuditWarning } from '../services/audit.service'
import type { ParsedBackup } from '../services/backup.service'
import { createVault, sealVault, unlockVault, verifyOwnPassword, type SetupInput } from '../services/auth.service'
import { redeemGrant, type RedeemInput } from '../services/grant.service'
import { pruneExpiredGrants } from '../services/grant-store'
import { noteSignIn } from '../services/user-profile'
import { completeTotpChallenge, openTotpChallenge, type TotpChallenge } from '../services/totp.service'

type Status = 'checking' | 'setup' | 'locked' | 'challenge' | 'ready' | 'error'
type SaveState = 'saved' | 'saving' | 'dirty' | 'error' | 'conflict'
export type VaultLockReason = 'manual' | 'idle'

export type ReplaceInput = { password: string; confirmName: string }

type VaultApi = {
  status: Status
  bootError: string | null
  user: SessionUser | null
  currency: string
  vaultName: string
  lastBackupAt: string | null
  revision: number
  saveState: SaveState
  weakPassword: boolean
  /** Recovery codes left after one was used at this sign-in; null when none was used. */
  recoveryLeft: number | null
  /** Failed sign-ins for this account in this browser since its last successful one. */
  failuresSeen: number
  /** Sign-ins for this account in this browser where the password was right but the sign-in check was not passed. */
  checkFailuresSeen: number
  storageNearLimit: boolean
  idleMinutes: IdleMinutes
  /** Why the vault last locked in this tab; null until it has been locked, and again once it is open. */
  lockReason: VaultLockReason | null
  /** For people who can read the audit log: a broken chain, or a log shorter than or different from what this browser saw. */
  auditWarning: AuditWarning | null
  setup: (input: SetupInput) => Promise<void>
  login: (email: string, password: string) => Promise<void>
  verifySignInCheck: (code: string) => Promise<{ usedRecovery: boolean; recoveryLeft: number }>
  cancelSignInCheck: () => void
  redeem: (input: RedeemInput) => Promise<void>
  guardWait: (scope: ThrottleScope, email: string) => number
  lock: (reason?: VaultLockReason) => Promise<void>
  importBackup: (backup: ParsedBackup) => Promise<void>
  replaceWithBackup: (backup: ParsedBackup, input: ReplaceInput) => Promise<void>
  exportBackup: () => Promise<VaultRecord>
  clearWeakPassword: () => void
  clearRecoveryNotice: () => void
  clearFailuresSeen: () => void
  dismissAuditWarning: () => void
  /** Accepts a shortened or changed log as it is now, writing that into the log. */
  acceptAuditLog: () => Promise<void>
  setIdleMinutes: (minutes: IdleMinutes) => void
  run: <T>(fn: (vault: OpenVault) => Promise<T> | T, options?: { dirty?: boolean }) => Promise<T>
  query: <T>(fn: (vault: OpenVault) => T) => T
}

type Unlocked = {
  vault: OpenVault
  loaded: LoadedVault
  release: () => void
  /** The sign-in went through the sign-in check. */
  checked: boolean
  weak: boolean
}

type PendingCheck = Unlocked & { challenge: TotpChallenge; timer: number }

const VaultContext = createContext<VaultApi | null>(null)
const SIGN_IN_CHECK_MS = 5 * 60_000

function snapshotUser(user: SessionUser): SessionUser {
  return { ...user, permissions: [...user.permissions] }
}

function bootErrorCode(error: unknown): string {
  if (error instanceof AppError) return error.code
  return error instanceof Error ? error.message : 'sqlite'
}

function isCodeFailure(error: unknown): boolean {
  return error instanceof AppError && (error.code === 'INVITE_INVALID' || error.code === 'INVITE_CODE')
}

/** Reads the record, records the clock, and removes codes whose plain-text expiry has passed before anything uses them. */
async function readFreshVault(): Promise<LoadedVault | null> {
  const loaded = await readVault()
  if (!loaded) return null
  const now = Math.max(Date.now(), observeClock())
  const pruned = pruneExpiredGrants(loaded.record, now)
  if (!pruned) return loaded
  try {
    await writeVault(pruned, { expectedStamp: stampOf(loaded.raw) })
  } catch {
    return loaded
  }
  return (await readVault()) ?? loaded
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
  const pendingRef = useRef<PendingCheck | null>(null)
  // While a log warning is open, this browser's mark stays where it was; an accepted warning moves it back to the log.
  const auditHeldRef = useRef(false)
  const auditResetRef = useRef(false)
  const [throttle] = useState(() => createThrottle({ mirror: indexedDbThrottleMirror() }))
  const throttleRef = useRef(throttle)
  const [status, setStatus] = useState<Status>('checking')
  const [bootError, setBootError] = useState<string | null>(null)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [currency, setCurrency] = useState('USD')
  const [vaultName, setVaultName] = useState('Jaybi')
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [weakPassword, setWeakPassword] = useState(false)
  const [recoveryLeft, setRecoveryLeft] = useState<number | null>(null)
  const [failuresSeen, setFailuresSeen] = useState(0)
  const [checkFailuresSeen, setCheckFailuresSeen] = useState(0)
  const [vaultBytes, setVaultBytes] = useState(0)
  const [idleMinutes, setIdleMinutesState] = useState<IdleMinutes>(() => readIdleMinutes())
  const [lockReason, setLockReason] = useState<VaultLockReason | null>(() => peekLockNotice())
  const [auditWarning, setAuditWarning] = useState<AuditWarning | null>(null)

  const observeAuditLog = useCallback((vault: OpenVault, recorded: AuditHead | undefined) => {
    const reader = canUser(vault.user, Permission.READ_AUDIT)
    const warning = checkAuditLog(vault.db, { device: readAuditMark(), record: recorded }, reader)
    auditHeldRef.current = warning !== null
    auditResetRef.current = false
    setAuditWarning(reader ? warning : null)
    if (!warning) advanceAuditMark(auditHead(vault.db))
  }, [])

  const markSaved = useCallback((head: AuditHead | undefined) => {
    if (!head) return
    if (auditResetRef.current) {
      resetAuditMark(head)
      auditResetRef.current = false
      auditHeldRef.current = false
    } else if (!auditHeldRef.current) {
      advanceAuditMark(head)
    }
  }, [])

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
      setVaultBytes(vault.db.sizeBytes())
      setSaveState('saved')
      setLockReason(null)
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
      markSaved(record.audit)
      setVaultBytes(vault.db.sizeBytes())
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
  }, [markSaved])

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

  const guardWait = useCallback((scope: ThrottleScope, email: string) => throttleRef.current.wait(scope, email), [])

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
        resetAuditMark(created.record.audit ?? null)
        releaseRef.current = release
        publish(created.vault, created.record.updatedAt)
      } catch (error) {
        release()
        throw error
      }
    },
    [publish],
  )

  /** Counters are cleared only here, once the whole sign-in has succeeded, so a correct password alone hides nothing. */
  const finishLogin = useCallback(
    async ({ vault, loaded, release, checked, weak }: Unlocked) => {
      const throttle = throttleRef.current
      const email = vault.user.email
      const login = throttle.peek('login', email)
      const totp = throttle.peek('totp', email)
      // This sign-in's own pending check was counted when it opened.
      const checkFailures = Math.max(0, throttle.peek('check', email).failures - (checked ? 1 : 0))
      const failures = login.failures + totp.failures
      const since = [login.since, totp.since].filter((value): value is string => value !== null).sort()[0] ?? null
      if (failures > 0 || checkFailures > 0) {
        writeAudit(vault.db, vault.user.id, 'SIGNIN_FAILURES_SEEN', 'user', vault.user.id, { failures, since, signInCheckFailures: checkFailures })
        vault.needsSave = true
      }
      if (noteSignIn(vault.db, vault.user.id)) vault.needsSave = true
      observeAuditLog(vault, loaded.record.audit)
      releaseRef.current = release
      publish(vault, stampOf(loaded.raw))
      setWeakPassword(weak)
      setFailuresSeen(failures)
      setCheckFailuresSeen(checkFailures)
      if (vault.needsSave) {
        const upgraded = loaded.sourceVersion < RECORD_VERSION || loaded.record.schemaVersion < SCHEMA_VERSION
        archiveRef.current = upgraded ? loaded.raw : null
        vault.needsSave = false
        dirtyRef.current = true
        setSaveState('dirty')
        await enqueuePersist()
      }
      for (const scope of ['login', 'totp', 'check'] as const) throttle.succeed(scope, email)
    },
    [publish, enqueuePersist, observeAuditLog],
  )

  const cancelSignInCheck = useCallback(() => {
    const pending = pendingRef.current
    if (!pending) return
    pendingRef.current = null
    window.clearTimeout(pending.timer)
    pending.vault.db.close()
    pending.release()
    setStatus('locked')
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      const throttle = throttleRef.current
      await throttle.ready
      const wait = throttle.wait('login', email)
      if (wait > 0) throw new ThrottledError(wait)
      const loaded = await readFreshVault()
      if (!loaded) {
        setStatus('setup')
        throw new AuthError()
      }
      const release = await acquireSessionLock()
      if (!release) throw new VaultInUseError()
      let vault: OpenVault
      try {
        vault = await unlockVault(loaded.record, email, password)
      } catch (error) {
        release()
        if (error instanceof AuthError) {
          const next = throttle.fail('login', email)
          if (next > 0) throw new ThrottledError(next)
        }
        throw error
      }
      try {
        const weak = (await passwordProblem(password, { email: vault.user.email, vaultName: vault.vaultName })) !== null
        const challenge = await openTotpChallenge(vault, password)
        const unlocked: Unlocked = { vault, loaded, release, checked: challenge !== null, weak }
        if (challenge) {
          // Counted now and cleared only by a full sign-in, so cancelling, timing out or closing the tab all leave a trace.
          throttle.note('check', vault.user.email)
          const timer = window.setTimeout(() => cancelSignInCheck(), SIGN_IN_CHECK_MS)
          pendingRef.current = { ...unlocked, challenge, timer }
          setStatus('challenge')
          return
        }
        await finishLogin(unlocked)
      } catch (error) {
        if (releaseRef.current !== release) {
          vault.db.close()
          release()
        }
        throw error
      }
    },
    [finishLogin, cancelSignInCheck],
  )

  const verifySignInCheck = useCallback(
    async (code: string) => {
      const pending = pendingRef.current
      if (!pending) throw new AuthError()
      const throttle = throttleRef.current
      const email = pending.vault.user.email
      const wait = throttle.wait('totp', email)
      if (wait > 0) throw new ThrottledError(wait)
      let result: { usedRecovery: boolean; recoveryLeft: number }
      try {
        result = await completeTotpChallenge(pending.vault, pending.challenge, code)
      } catch (error) {
        if (error instanceof ValidationError && error.code === 'TOTP_INVALID') {
          const next = throttle.fail('totp', email)
          if (next > 0) throw new ThrottledError(next)
        }
        throw error
      }
      pendingRef.current = null
      window.clearTimeout(pending.timer)
      pending.vault.needsSave = true
      await finishLogin(pending)
      setRecoveryLeft(result.usedRecovery ? result.recoveryLeft : null)
      return result
    },
    [finishLogin],
  )

  const redeem = useCallback(
    async (input: RedeemInput) => {
      const throttle = throttleRef.current
      await throttle.ready
      const wait = throttle.wait('code', input.email)
      if (wait > 0) throw new ThrottledError(wait)
      // Not pruned first: an expired code should say so. It is pruned right after, and at every load.
      const loaded = await readVault()
      if (!loaded) throw new ValidationError('NO_VAULT')
      const release = await acquireSessionLock()
      if (!release) throw new VaultInUseError()
      let vault: OpenVault
      try {
        vault = await redeemGrant(loaded.record, input)
      } catch (error) {
        release()
        if (error instanceof AppError && error.code === 'INVITE_EXPIRED') await readFreshVault().catch(() => null)
        if (isCodeFailure(error)) {
          const next = throttle.fail('code', input.email)
          if (next > 0) throw new ThrottledError(next)
        }
        throw error
      }
      try {
        // Save before publishing so the used code is gone from storage before anything else happens.
        observeAuditLog(vault, loaded.record.audit)
        noteSignIn(vault.db, vault.user.id)
        const record = await sealVault(vault)
        await writeVault(record, { expectedStamp: stampOf(loaded.raw) })
        markSaved(record.audit)
        vault.needsSave = false
        throttle.succeed('code', input.email)
        releaseRef.current = release
        publish(vault, record.updatedAt)
        setWeakPassword(false)
      } catch (error) {
        vault.db.close()
        release()
        throw error
      }
    },
    [publish, observeAuditLog, markSaved],
  )

  const lock = useCallback(async (reason: VaultLockReason = 'manual') => {
    cancelSignInCheck()
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    const vault = vaultRef.current
    vaultRef.current = null
    vault?.db.close()
    dirtyRef.current = false
    archiveRef.current = null
    releaseSession()
    setUser(null)
    setWeakPassword(false)
    setRecoveryLeft(null)
    setFailuresSeen(0)
    setCheckFailuresSeen(0)
    if (vault) {
      // A reload drops the JavaScript heap and the SQLite WASM memory, so no decrypted data outlives the session.
      rememberLockNotice(reason)
      setStatus('checking')
      window.history.replaceState(null, '', lockUrl(window.location, reason))
      window.location.reload()
      return
    }
    setLockReason(null)
    setStatus('locked')
  }, [enqueuePersist, releaseSession, cancelSignInCheck])

  const closeAfterReplace = useCallback(() => {
    const current = vaultRef.current
    vaultRef.current = null
    current?.db.close()
    dirtyRef.current = false
    conflictRef.current = false
    archiveRef.current = null
    releaseSession()
    setUser(null)
    setWeakPassword(false)
    setRecoveryLeft(null)
    setFailuresSeen(0)
    setCheckFailuresSeen(0)
    setSaveState('saved')
    setLockReason(null)
    setAuditWarning(null)
    // A different log now lives here; the next sign-in starts from the head its record carries.
    resetAuditMark(null)
    auditHeldRef.current = false
    setStatus('locked')
  }, [releaseSession])

  /** First-run import only: an existing vault is replaced through {@link replaceWithBackup}. */
  const importBackup = useCallback(
    async (backup: ParsedBackup) => {
      if ((await readVaultRaw()) !== undefined) throw new ValidationError('VAULT_EXISTS')
      await writeVault(backup.record, { expectedStamp: null })
      closeAfterReplace()
    },
    [closeAfterReplace],
  )

  const replaceWithBackup = useCallback(
    async (backup: ParsedBackup, input: ReplaceInput) => {
      const vault = vaultRef.current
      if (!vault) throw new Error('LOCKED')
      if (!canUser(vault.user, Permission.IMPORT_VAULT)) throw new ForbiddenError()
      if (input.confirmName.trim().toLocaleLowerCase() !== vault.vaultName.trim().toLocaleLowerCase()) throw new ValidationError('CONFIRM_NAME')
      await verifyOwnPassword(vault, input.password)
      if (dirtyRef.current) enqueuePersist()
      await chainRef.current
      if (conflictRef.current) throw new ConflictError()
      writeAudit(vault.db, vault.user.id, 'VAULT_REPLACED_BY_IMPORT', 'vault', 'primary', {
        backupAppVersion: backup.appVersion,
        backupSchemaVersion: backup.record.schemaVersion,
        backupExportedAt: backup.exportedAt,
        people: backup.record.wraps.length,
      })
      const sealed = await sealVault(vault)
      await writeVault(backup.record, {
        expectedStamp: stampRef.current,
        archive: { reason: 'import', raw: encodeStoredRecord(sealed) },
      })
      closeAfterReplace()
    },
    [enqueuePersist, closeAfterReplace],
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

  const clearWeakPassword = useCallback(() => setWeakPassword(false), [])
  const clearRecoveryNotice = useCallback(() => setRecoveryLeft(null), [])
  const dismissAuditWarning = useCallback(() => setAuditWarning(null), [])

  const acceptAuditLog = useCallback(async () => {
    const warning = auditWarning
    if (!warning || warning.kind === 'BROKEN') return
    await run((vault) => acknowledgeAuditWarning(vault, warning), { dirty: true })
    auditResetRef.current = true
    setAuditWarning(null)
  }, [auditWarning, run])

  const clearFailuresSeen = useCallback(() => {
    setFailuresSeen(0)
    setCheckFailuresSeen(0)
  }, [])

  const setIdleMinutes = useCallback((minutes: IdleMinutes) => {
    storeIdleMinutes(minutes)
    setIdleMinutesState(minutes)
  }, [])

  useEffect(() => clearLockNotice(), [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const existing = await readFreshVault()
        if (cancelled) return
        setStatus(existing ? 'locked' : 'setup')
      } catch (error) {
        if (cancelled) return
        setBootError(bootErrorCode(error))
        setStatus('error')
      }
    })()
    void stripArchivedGrants().catch(() => undefined)
    const onVisible = () => {
      if (document.visibilityState === 'visible') observeClock()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
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
    if (status !== 'ready') return
    return watchIdle({ idleMs: idleMinutes * 60_000, onIdle: () => void lock('idle') })
  }, [status, lock, idleMinutes])

  useEffect(() => {
    return () => {
      if (debounceRef.current != null) window.clearTimeout(debounceRef.current)
    }
  }, [])

  const storageNearLimit = vaultBytes >= LIMITS.databaseWarnBytes

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
      weakPassword,
      recoveryLeft,
      failuresSeen,
      checkFailuresSeen,
      storageNearLimit,
      idleMinutes,
      lockReason,
      auditWarning,
      setup,
      login,
      verifySignInCheck,
      cancelSignInCheck,
      redeem,
      guardWait,
      lock,
      importBackup,
      replaceWithBackup,
      exportBackup,
      clearWeakPassword,
      clearRecoveryNotice,
      clearFailuresSeen,
      dismissAuditWarning,
      acceptAuditLog,
      setIdleMinutes,
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
      weakPassword,
      recoveryLeft,
      failuresSeen,
      checkFailuresSeen,
      storageNearLimit,
      idleMinutes,
      lockReason,
      auditWarning,
      setup,
      login,
      verifySignInCheck,
      cancelSignInCheck,
      redeem,
      guardWait,
      lock,
      importBackup,
      replaceWithBackup,
      exportBackup,
      clearWeakPassword,
      clearRecoveryNotice,
      clearFailuresSeen,
      dismissAuditWarning,
      acceptAuditLog,
      setIdleMinutes,
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
