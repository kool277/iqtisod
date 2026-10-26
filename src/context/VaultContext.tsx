import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { auditHead, type AuditHead } from '../db/audit-chain'
import { readVault, readVaultRaw, stampOf, stripArchivedGrantsOnce, writeVault, type LoadedVault, type VaultRecord } from '../db/storage'
import { KEYS_RECORD_VERSION, RECORD_VERSION, SCHEMA_VERSION } from '../db/versions'
import type { OpenVault, SessionUser } from '../domain/types'
import { AppError, AuthError, ConflictError, ForbiddenError, KeysBlockedError, OlderBackupError, ValidationError, VaultInUseError } from '../domain/errors'
import { keysEnabled } from '../lib/flags'
import { observeClock } from '../lib/device-clock'
import { readIdleMinutes, storeIdleMinutes, watchIdle, type IdleMinutes } from '../lib/idle'
import { advanceAuditMark, readAuditMark, resetAuditMark } from '../lib/audit-mark'
import { LIMITS } from '../lib/limits'
import { clearLockNotice, lockUrl, peekLockNotice, rememberLockNotice } from '../lib/lock-reload'
import { passwordProblem } from '../lib/password-policy'
import { requestPersistenceBriefly } from '../lib/persistence'
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

/** `trust`: a first sign-in to a per-person-keys vault in this browser, waiting for the person to compare the founder key. */
type Status = 'checking' | 'setup' | 'locked' | 'trust' | 'challenge' | 'ready' | 'error'
type SaveState = 'saved' | 'saving' | 'dirty' | 'error' | 'conflict'
export type VaultLockReason = 'manual' | 'idle'

export type ReplaceInput = {
  password: string
  confirmName: string
  /** For a backup with per-person keys: the person's password in it, when it was not the one they use now. */
  backupPassword?: string
  /** Restore a backup older than this browser has seen, taking out again the people removed since (design 4.10). */
  acceptOlder?: boolean
}

/** What the screens show about an open per-person-keys vault. */
export type KeysInfo = {
  vaultId: string
  memberId: string
  /** The founder key's fingerprint (32 hex characters), compared out loud between members. */
  fingerprint: string
  founder: boolean
  rosterVersion: number
}

export type LoginOptions = {
  /** An admin opens a copy whose signed member list is older than this browser has seen (design 4.10). */
  acceptRollback?: boolean
}

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
  /** Set for a per-person-keys vault (record 3). */
  keysInfo: KeysInfo | null
  /** The founder fingerprint to compare while `status` is `trust`. */
  trustFingerprint: string | null
  confirmTrust: () => Promise<void>
  cancelTrust: () => void
  /** Shown once after a vault is created, upgraded, or joined in this browser: the founder fingerprint to write down. */
  fingerprintNotice: string | null
  dismissFingerprintNotice: () => void
  /** An admin of a 1.x vault in a build with per-person keys: the upgrade is offered until they upgrade or postpone it. */
  upgradeOffered: boolean
  upgradeKeys: (password: string) => Promise<void>
  postponeUpgrade: () => void
  setup: (input: SetupInput) => Promise<void>
  login: (email: string, password: string, options?: LoginOptions) => Promise<void>
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

type PendingTrust = Unlocked & { challenge: TotpChallenge | null; timer: number }

const VaultContext = createContext<VaultApi | null>(null)
const SIGN_IN_CHECK_MS = 5 * 60_000

function snapshotUser(user: SessionUser): SessionUser {
  return { ...user, permissions: [...user.permissions] }
}

function bootErrorCode(error: unknown): string {
  if (error instanceof AppError) return error.code
  return error instanceof Error ? error.message : 'sqlite'
}

function keysInfoOf(vault: OpenVault): KeysInfo | null {
  const keys = vault.keys
  if (!keys) return null
  return { vaultId: keys.vaultId, memberId: keys.memberId, fingerprint: keys.founder.fingerprint, founder: keys.founder.memberId === keys.memberId, rosterVersion: keys.roster.version }
}

function offersUpgrade(vault: OpenVault): boolean {
  return keysEnabled() && !vault.keys && vault.user.roleName === 'Admin' && canUser(vault.user, Permission.MANAGE_USERS)
}

/** Refusals that happen before the founder upgrade changes anything, so the open session is still the 1.x one. */
function upgradeRefusedEarly(error: unknown): boolean {
  return error instanceof AuthError || error instanceof ForbiddenError || (error instanceof ValidationError && ['V2_UNSUPPORTED_BROWSER', 'ALREADY_UPGRADED', 'SCHEMA_UNKNOWN', 'KDF_MEMORY'].includes(error.code))
}

/** The session helpers of a per-person-keys vault, loaded only for such a vault. */
function keysSession(): Promise<typeof import('../services/v2/session')> {
  return import('../services/v2/session')
}

/** The audit checkpoint of a per-person-keys vault, loaded only for such a vault. */
function auditSeen(): Promise<typeof import('../services/v2/audit-seen')> {
  return import('../services/v2/audit-seen')
}

/** Keeps the checkpoint at `seq`; the entries up to it no longer change, so it may run after the save returned. */
function keepCheckpoint(vault: OpenVault, seq: number, options: { reset?: boolean } = {}): void {
  const keys = vault.keys
  if (!keys) return
  void auditSeen()
    .then(({ keepAuditSeen }) => keepAuditSeen(vault.db, keys.vaultId, seq, options))
    .catch(() => undefined)
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
  const trustRef = useRef<PendingTrust | null>(null)
  // While a log warning is open, this browser's mark stays where it was; an accepted warning moves it back to the log.
  const auditHeldRef = useRef(false)
  const auditResetRef = useRef<AuditWarning['kind'] | null>(null)
  // The signature check of a per-person-keys vault: until it passed, a save does not move this browser's checkpoint,
  // and an accepted warning moves it only over entries that were checked (`warned`: problems were shown).
  const signaturesRef = useRef<'idle' | 'checking' | 'ok' | 'warned' | 'failed'>('idle')
  // Signature problems found while another warning was showing, shown once that one is accepted.
  const signatureWarningRef = useRef<AuditWarning | null>(null)
  const capacityRef = useRef<(() => void) | null>(null)
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
  const [warnBytes, setWarnBytes] = useState<number>(LIMITS.databaseWarnBytes)
  const [idleMinutes, setIdleMinutesState] = useState<IdleMinutes>(() => readIdleMinutes())
  const [lockReason, setLockReason] = useState<VaultLockReason | null>(() => peekLockNotice())
  const [auditWarning, setAuditWarning] = useState<AuditWarning | null>(null)
  const [keysInfo, setKeysInfo] = useState<KeysInfo | null>(null)
  const [trustFingerprint, setTrustFingerprint] = useState<string | null>(null)
  const [fingerprintNotice, setFingerprintNotice] = useState<string | null>(null)
  const [upgradeOffered, setUpgradeOffered] = useState(false)

  const observeAuditLog = useCallback((vault: OpenVault, recorded: AuditHead | undefined) => {
    const reader = canUser(vault.user, Permission.READ_AUDIT)
    const warning = checkAuditLog(vault.db, { device: readAuditMark(), record: recorded }, reader)
    auditHeldRef.current = warning !== null
    auditResetRef.current = null
    signatureWarningRef.current = null
    setAuditWarning(reader ? warning : null)
    if (!warning) advanceAuditMark(auditHead(vault.db))
  }, [])

  const markSaved = useCallback((head: AuditHead | undefined) => {
    if (!head) return
    const vault = vaultRef.current
    const accepted = auditResetRef.current
    if (accepted) {
      resetAuditMark(head)
      auditResetRef.current = null
      auditHeldRef.current = false
      if (vault?.keys && (signaturesRef.current === 'ok' || (signaturesRef.current === 'warned' && accepted === 'SIGNATURES'))) {
        signaturesRef.current = 'ok'
        keepCheckpoint(vault, head.seq, { reset: true })
      }
      return
    }
    if (!auditHeldRef.current) advanceAuditMark(head)
    // Everything up to a saved head was checked since sign-in or signed by this session.
    if (vault?.keys && signaturesRef.current === 'ok') keepCheckpoint(vault, head.seq)
  }, [])

  /** A log this session wrote from its first entry, or signed from its bridge on: this browser's checkpoint starts at it. */
  const trustOwnLog = useCallback((vault: OpenVault, head: AuditHead | undefined) => {
    if (!vault.keys || !head || !canUser(vault.user, Permission.READ_AUDIT)) return
    signaturesRef.current = 'ok'
    keepCheckpoint(vault, head.seq, { reset: true })
  }, [])

  /**
   * For people who can read the audit log of a vault with per-person keys: checks the signatures of the entries since
   * this browser's last check, once the session is open. It warns and blocks nothing (design 3.8 step 6).
   */
  const checkSignatures = useCallback((vault: OpenVault) => {
    signaturesRef.current = 'idle'
    const keys = vault.keys
    if (!keys || !canUser(vault.user, Permission.READ_AUDIT)) return
    signaturesRef.current = 'checking'
    void import('../services/v2/audit-check')
      .then(({ checkVaultAudit }) => checkVaultAudit(vault as OpenVault & { keys: typeof keys }))
      .then((report) => {
        if (vaultRef.current !== vault) return
        if (report && report.problems.size === 0) {
          signaturesRef.current = 'ok'
          keepCheckpoint(vault, report.checkpoint.seq)
          return
        }
        if (!report) {
          signaturesRef.current = 'failed'
          return
        }
        signaturesRef.current = 'warned'
        let firstSeq = Number.MAX_SAFE_INTEGER
        for (const seq of report.problems.keys()) if (seq < firstSeq) firstSeq = seq
        const warning: AuditWarning = { kind: 'SIGNATURES', count: report.problems.size, firstSeq }
        setAuditWarning((current) => {
          if (current === null) return warning
          signatureWarningRef.current = warning
          return current
        })
      })
      .catch(() => {
        if (vaultRef.current === vault) signaturesRef.current = 'failed'
      })
  }, [])

  const syncState = useCallback((vault: OpenVault) => {
    setUser(snapshotUser(vault.user))
    setCurrency(vault.currency)
    setVaultName(vault.vaultName)
    setLastBackupAt(vault.lastBackupAt)
    setKeysInfo(keysInfoOf(vault))
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
      setUpgradeOffered(offersUpgrade(vault))
      void requestPersistenceBriefly()
        .then(() => import('../lib/capacity'))
        .then(async ({ growthBudget, measureCapacity, onCapacity, setChunkedVault }) => {
          // A per-person-keys vault is stored in chunks, so Chromium's single-value limit does not cap it.
          setChunkedVault(vault.keys !== undefined)
          // Every measurement moves the receipt limit (finance.service reads the latest), so the warning follows it.
          capacityRef.current ??= onCapacity((capacity) => setWarnBytes(growthBudget(capacity).warnBytes))
          await measureCapacity()
        })
        .catch(() => undefined)
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
      const session = vault.keys ? await keysSession() : null
      await writeVault(record, {
        expectedStamp: stampRef.current,
        archive: archive === null ? undefined : { reason: 'upgrade', raw: archive },
        rotation: session?.rotationOf(vault, record),
      })
      session?.commitSealed(vault, record)
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

  /** Runs `task` in the save queue, so no autosave runs while it seals or writes. Its result or error is returned. */
  const inChain = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const result = chainRef.current.then(task)
    chainRef.current = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }, [])

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
        const created = keysEnabled() ? await (await import('../services/v2/vault')).createKeysVault(input) : await createVault(input)
        try {
          await writeVault(created.record, { expectedStamp: null })
        } catch (error) {
          created.vault.db.close()
          throw error
        }
        if (created.vault.keys) {
          const session = await keysSession()
          session.commitSealed(created.vault, created.record)
          session.confirmKeysSession(created.vault)
        }
        if (created.vault.keys) setFingerprintNotice(created.vault.keys.founder.fingerprint)
        resetAuditMark(created.record.audit ?? null)
        releaseRef.current = release
        publish(created.vault, created.record.updatedAt)
        trustOwnLog(created.vault, created.record.audit)
      } catch (error) {
        release()
        throw error
      }
    },
    [publish, trustOwnLog],
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
      // Only now, with everything passed: pin the founder on a first sign-in and raise this browser's roster mark.
      if (vault.keys) (await keysSession()).confirmKeysSession(vault)
      observeAuditLog(vault, loaded.record.audit)
      releaseRef.current = release
      publish(vault, stampOf(loaded.raw))
      checkSignatures(vault)
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
    [publish, enqueuePersist, observeAuditLog, checkSignatures],
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

  const cancelTrust = useCallback(() => {
    const pending = trustRef.current
    if (!pending) return
    trustRef.current = null
    window.clearTimeout(pending.timer)
    pending.vault.db.close()
    pending.release()
    setTrustFingerprint(null)
    setStatus('locked')
  }, [])

  /** The sign-in after the password (and, on a first sign-in to a per-person-keys vault, the founder comparison). */
  const continueSignIn = useCallback(
    async (unlocked: Unlocked, challenge: TotpChallenge | null) => {
      if (challenge) {
        // Counted now and cleared only by a full sign-in, so cancelling, timing out or closing the tab all leave a trace.
        throttleRef.current.note('check', unlocked.vault.user.email)
        const timer = window.setTimeout(() => cancelSignInCheck(), SIGN_IN_CHECK_MS)
        pendingRef.current = { ...unlocked, challenge, timer }
        setStatus('challenge')
        return
      }
      await finishLogin(unlocked)
    },
    [finishLogin, cancelSignInCheck],
  )

  const login = useCallback(
    async (email: string, password: string, options: LoginOptions = {}) => {
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
      const acceptRollback = options.acceptRollback === true && loaded.record.version === KEYS_RECORD_VERSION
      try {
        vault =
          acceptRollback && loaded.record.version === KEYS_RECORD_VERSION
            ? await (await import('../services/v2/vault')).unlockKeysVault(loaded.record, email, password, { acceptRollback: true })
            : await unlockVault(loaded.record, email, password)
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
        if (vault.keys?.firstSeen) {
          // First sign-in to this household in this browser: compare the founder key before anything else (TOFU).
          const timer = window.setTimeout(() => cancelTrust(), SIGN_IN_CHECK_MS)
          trustRef.current = { ...unlocked, challenge, timer }
          setTrustFingerprint(vault.keys.founder.fingerprint)
          setStatus('trust')
          return
        }
        await continueSignIn(unlocked, challenge)
      } catch (error) {
        if (releaseRef.current !== release && pendingRef.current?.vault !== vault && trustRef.current?.vault !== vault) {
          vault.db.close()
          release()
        }
        throw error
      }
    },
    [continueSignIn, cancelTrust],
  )

  const confirmTrust = useCallback(async () => {
    const pending = trustRef.current
    if (!pending) throw new AuthError()
    trustRef.current = null
    window.clearTimeout(pending.timer)
    setTrustFingerprint(null)
    try {
      await continueSignIn(pending, pending.challenge)
    } catch (error) {
      if (releaseRef.current !== pending.release && pendingRef.current?.vault !== pending.vault) {
        pending.vault.db.close()
        pending.release()
        setStatus('locked')
      }
      throw error
    }
  }, [continueSignIn])

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
        const session = vault.keys ? await keysSession() : null
        session?.commitSealed(vault, record)
        // The code has been used up and saved, so there is nothing to cancel: the founder key is shown to compare.
        if (vault.keys?.firstSeen) setFingerprintNotice(vault.keys.founder.fingerprint)
        session?.confirmKeysSession(vault)
        markSaved(record.audit)
        vault.needsSave = false
        throttle.succeed('code', input.email)
        releaseRef.current = release
        publish(vault, record.updatedAt)
        checkSignatures(vault)
        setWeakPassword(false)
      } catch (error) {
        vault.db.close()
        release()
        throw error
      }
    },
    [publish, observeAuditLog, markSaved, checkSignatures],
  )

  const lock = useCallback(async (reason: VaultLockReason = 'manual') => {
    cancelSignInCheck()
    cancelTrust()
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    const vault = vaultRef.current
    vaultRef.current = null
    vault?.db.close()
    dirtyRef.current = false
    archiveRef.current = null
    signaturesRef.current = 'idle'
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
  }, [enqueuePersist, releaseSession, cancelSignInCheck, cancelTrust])

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
    signaturesRef.current = 'idle'
    signatureWarningRef.current = null
    setStatus('locked')
  }, [releaseSession])

  /** First-run import only: an existing vault is replaced through {@link replaceWithBackup}. */
  const importBackup = useCallback(
    async (backup: ParsedBackup) => {
      if ((await readVaultRaw()) !== undefined) throw new ValidationError('VAULT_EXISTS')
      await writeVault(backup.record, { expectedStamp: null })
      if (backup.record.version === KEYS_RECORD_VERSION) (await auditSeen()).forgetAuditSeen(backup.record.keys.vaultId)
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
      let replacement: VaultRecord = backup.record
      let adopt: (() => void) | null = null
      if (backup.record.version === KEYS_RECORD_VERSION) {
        // It must come from the household this browser knows, if it knows one by that id: there is no override, since
        // a vault id is random and the same id with another founder is a forgery or damage.
        const pinned = (await keysSession()).pinnedFounder(backup.record.keys.vaultId)
        if (pinned !== null && pinned !== backup.record.keys.founder.sigPub) throw new KeysBlockedError('KEYS_FOUNDER_MISMATCH')
        // Every check of a sign-in, as the person restoring it (design 4.9).
        const restore = await import('../services/v2/restore')
        const check = await restore.checkKeysBackup(backup.record, vault.user.email, input.backupPassword || input.password)
        try {
          if (check.older) {
            if (!input.acceptOlder) throw new OlderBackupError(check.older)
            // An older copy goes in only as its admin chose: with everyone whose access ended since taken out again,
            // sealed anew.
            restore.takeOutAgain(check.vault, check.older.removals ?? [])
            const sealed = (await sealVault(check.vault)) as Extract<VaultRecord, { version: typeof KEYS_RECORD_VERSION }>
            adopt = restore.adoptionOf(check.vault, sealed)
            replacement = sealed
          }
        } finally {
          // Closed before the open vault is sealed for its archive, so two decrypted vaults are not held at once longer
          // than the checks need.
          check.vault.db.close()
        }
      } else if (vault.keys && !input.acceptOlder) {
        // A 1.x backup over a vault with per-person keys brings back every password it holds, removed people's too.
        throw new OlderBackupError({ seen: vault.keys.roster.version, version: 0, removals: null, legacy: true })
      }
      await inChain(async () => {
        writeAudit(vault.db, vault.user.id, 'VAULT_REPLACED_BY_IMPORT', 'vault', 'primary', {
          backupAppVersion: backup.appVersion,
          backupSchemaVersion: backup.record.schemaVersion,
          backupExportedAt: backup.exportedAt,
          people: replacement.version === KEYS_RECORD_VERSION ? Object.keys(replacement.keys.identities).length : replacement.wraps.length,
        })
        const sealed = await sealVault(vault)
        await writeVault(replacement, {
          expectedStamp: stampRef.current,
          archive: { reason: 'import', record: sealed },
        })
      })
      adopt?.()
      // The next sign-in checks every signature of the log that now lives here.
      if (vault.keys || replacement.version === KEYS_RECORD_VERSION) {
        const { forgetAuditSeen } = await auditSeen()
        if (vault.keys) forgetAuditSeen(vault.keys.vaultId)
        if (replacement.version === KEYS_RECORD_VERSION) forgetAuditSeen(replacement.keys.vaultId)
      }
      closeAfterReplace()
    },
    [enqueuePersist, closeAfterReplace, inChain],
  )

  const exportBackup = useCallback(async () => {
    const vault = vaultRef.current
    if (!vault) throw new Error('LOCKED')
    if (dirtyRef.current) enqueuePersist()
    await chainRef.current
    if (conflictRef.current) throw new ConflictError()
    // The save failed (the browser refused to store the vault, or ran out of room): the stored copy is behind, so the
    // backup is sealed from the open vault, the only place the latest changes are. In the queue, so no autosave
    // changes the session while it seals.
    if (dirtyRef.current) return inChain(() => sealVault(vault, { full: true }))
    const loaded = await readVault()
    if (!loaded) throw new Error('MISSING')
    return loaded.record
  }, [enqueuePersist, inChain])

  const upgradeKeys = useCallback(
    async (password: string) => {
      const vault = vaultRef.current
      if (!vault) throw new Error('LOCKED')
      if (vault.keys) throw new ValidationError('ALREADY_UPGRADED')
      // Nothing of this session may be saved after the database in memory was upgraded unless the 1.x record is
      // archived in the same write: a failure from then on drops the session, which the reload after the lock clears.
      let discarded = false
      const discard = () => {
        discarded = true
        conflictRef.current = true
        dirtyRef.current = false
      }
      let upgraded: Awaited<ReturnType<typeof import('../services/v2/upgrade').upgradeToKeys>>
      try {
        upgraded = await inChain(async () => {
          if (dirtyRef.current) await persistNow()
          if (conflictRef.current || dirtyRef.current) throw new ConflictError()
          // The 1.x record as stored is kept as the rollback path; it must be the one this session last saved.
          const raw = await readVaultRaw()
          if (raw === undefined || stampOf(raw) !== stampRef.current) throw new ConflictError()
          const { upgradeToKeys } = await import('../services/v2/upgrade')
          let result: Awaited<ReturnType<typeof upgradeToKeys>>
          try {
            result = await upgradeToKeys(vault, password)
          } catch (error) {
            if (!upgradeRefusedEarly(error)) discard()
            throw error
          }
          try {
            await writeVault(result.record, { expectedStamp: stampRef.current, archive: { reason: 'upgrade', raw } })
          } catch (error) {
            discard()
            throw error
          }
          return result
        })
      } catch (error) {
        if (discarded) void lock()
        throw error
      }
      const session = await keysSession()
      session.commitSealed(vault, upgraded.record)
      session.confirmKeysSession(vault)
      stampRef.current = upgraded.record.updatedAt
      markSaved(upgraded.record.audit)
      trustOwnLog(vault, upgraded.record.audit)
      syncState(vault)
      setUpgradeOffered(false)
      setFingerprintNotice(upgraded.vault.keys.founder.fingerprint)
      setRevision((value) => value + 1)
      void import('../lib/capacity').then(({ setChunkedVault, measureCapacity }) => {
        setChunkedVault(true)
        return measureCapacity()
      })
    },
    [inChain, persistNow, lock, markSaved, syncState, trustOwnLog],
  )

  const postponeUpgrade = useCallback(() => setUpgradeOffered(false), [])
  const dismissFingerprintNotice = useCallback(() => setFingerprintNotice(null), [])

  const clearWeakPassword = useCallback(() => setWeakPassword(false), [])
  const clearRecoveryNotice = useCallback(() => setRecoveryLeft(null), [])
  // Signature problems found while another warning showed come next.
  const dismissAuditWarning = useCallback(() => {
    const next = auditWarning?.kind === 'SIGNATURES' ? null : signatureWarningRef.current
    signatureWarningRef.current = null
    setAuditWarning(next)
  }, [auditWarning])

  const acceptAuditLog = useCallback(async () => {
    const warning = auditWarning
    if (!warning || warning.kind === 'BROKEN') return
    await run((vault) => acknowledgeAuditWarning(vault, warning), { dirty: true })
    auditResetRef.current = warning.kind
    // Signature problems found meanwhile come next; accepting them is a choice of its own.
    const next = warning.kind === 'SIGNATURES' ? null : signatureWarningRef.current
    signatureWarningRef.current = null
    setAuditWarning(next)
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
    void stripArchivedGrantsOnce().catch(() => undefined)
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
      capacityRef.current?.()
    }
  }, [])

  const storageNearLimit = vaultBytes >= warnBytes

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
      keysInfo,
      trustFingerprint,
      confirmTrust,
      cancelTrust,
      fingerprintNotice,
      dismissFingerprintNotice,
      upgradeOffered,
      upgradeKeys,
      postponeUpgrade,
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
      keysInfo,
      trustFingerprint,
      confirmTrust,
      cancelTrust,
      fingerprintNotice,
      dismissFingerprintNotice,
      upgradeOffered,
      upgradeKeys,
      postponeUpgrade,
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
