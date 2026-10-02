import { CURRENT_KDF, isKdfParams, kdfNeedsUpgrade, randomBytes, type KdfParams } from '../crypto/crypto.service'
import { base64ToBytes, bytesToBase64 } from '../crypto/encoding'
import {
  ENC_VERSION,
  PERSONAL_KEY_USAGES,
  PK_SALT_BYTES,
  RECOVERY_SALT_BYTES,
  SAFE_KEY_USAGES,
  aad,
  derivePersonalKek,
  deriveRecoveryKek,
  generateAesKey,
  generateRecoveryCode,
  openJson,
  parseRecoveryCode,
  sealJson,
  unwrapWithAad,
  wrapWithAad,
  type Sealed,
} from '../crypto/safe-crypto'
import type { SqlDatabase, SqlValue } from '../db/sqlite'
import { AuthError, SafeError, ValidationError } from '../domain/errors'
import { validateItemInput } from '../domain/items'
import {
  AUTO_LOCK_MINUTES,
  CLIPBOARD_SECONDS,
  DEFAULT_PREFS,
  RECENT_AUTH_MS,
  REVEAL_SECONDS,
  SAFE_EVENT_TYPES,
  SAFE_LIMITS,
  TRASH_DAYS,
  sameName,
  validateSafeInput,
  type SafeEvent,
  type SafeEventType,
  type SafeInput,
  type SafeMeta,
  type SafePrefs,
  type SecureItem,
  type SecureItemInput,
  type SecureItemPayload,
  type UserSafeMeta,
} from '../domain/safes'
import type { OpenVault } from '../domain/types'
import { verifyOwnPassword } from './auth.service'

const DAY_MS = 86_400_000

export type SafeKeyring = {
  userId: string
  personalKey: CryptoKey
  safeKeys: Map<string, { key: CryptoKey; version: number }>
  openSafes: Set<string>
  meta: UserSafeMeta
  lastAuthAt: number
}

export type SafeStatus = { initialized: boolean; mustChangePassword: boolean; stale: boolean; hasRecovery: boolean }

export type SafeSummary = {
  id: string
  meta: SafeMeta | null
  keyVersion: number
  itemCount: number
  trashedItemCount: number
  deletedAt: string | null
  isDefault: boolean
  open: boolean
}

export type UnlockSecret =
  | { kind: 'password'; password: string }
  | { kind: 'previousPassword'; previous: string; current: string }
  | { kind: 'recoveryCode'; code: string; current: string }

export type SetupOptions = { recovery: boolean; defaultSafeName: string }

export type TrashedItem = SecureItem & { daysLeft: number; safeName: string | null }

type UserKeysRow = {
  kdf: KdfParams
  kdfSalt: Uint8Array
  wrap: Sealed
  recovery: { salt: Uint8Array; wrap: Sealed } | null
  meta: Sealed
  createdAt: string
  rewrappedAt: string
}

type SafeRow = { id: string; keyVersion: number; keyWrap: Sealed; meta: Sealed; deletedAt: string | null }
type ItemRow = { id: string; safeId: string; keyVersion: number; rev: number; sealed: Sealed; deletedAt: string | null }
type EventRow = { id: string; iv: string; ct: string }
type Writer = (db: SqlDatabase) => void

const str = (value: SqlValue): string => String(value)
const optStr = (value: SqlValue): string | null => (value == null ? null : String(value))

function changes(db: SqlDatabase): number {
  return Number(db.queryValue('SELECT changes()') ?? 0)
}

function nowIso(): string {
  return new Date().toISOString()
}

function assertKeyring(vault: OpenVault, keyring: SafeKeyring | null): asserts keyring is SafeKeyring {
  if (!keyring || keyring.userId !== vault.user.id) throw new SafeError('SAFES_LOCKED')
}

function readUserKeys(db: SqlDatabase, userId: string): UserKeysRow | null {
  const row = db.queryOne('SELECT * FROM user_keys WHERE user_id = ?', [userId])
  if (!row) return null
  let kdf: unknown
  try {
    kdf = JSON.parse(str(row.kdf))
  } catch {
    kdf = null
  }
  if (!isKdfParams(kdf) || Number(row.enc_version) !== ENC_VERSION) throw new SafeError('SAFES_NOT_SET_UP')
  return {
    kdf,
    kdfSalt: base64ToBytes(str(row.kdf_salt)),
    wrap: { iv: str(row.wrap_iv), ct: str(row.wrapped_key) },
    recovery:
      row.recovery_salt == null
        ? null
        : { salt: base64ToBytes(str(row.recovery_salt)), wrap: { iv: str(row.recovery_iv), ct: str(row.recovery_wrapped_key) } },
    meta: { iv: str(row.meta_iv), ct: str(row.meta_ciphertext) },
    createdAt: str(row.created_at),
    rewrappedAt: str(row.rewrapped_at),
  }
}

function toSafeRow(row: Record<string, SqlValue>): SafeRow {
  return {
    id: str(row.id),
    keyVersion: Number(row.key_version),
    keyWrap: { iv: str(row.key_iv), ct: str(row.wrapped_key) },
    meta: { iv: str(row.meta_iv), ct: str(row.meta_ciphertext) },
    deletedAt: optStr(row.deleted_at),
  }
}

function toItemRow(row: Record<string, SqlValue>): ItemRow {
  return {
    id: str(row.id),
    safeId: str(row.safe_id),
    keyVersion: Number(row.key_version),
    rev: Number(row.rev),
    sealed: { iv: str(row.iv), ct: str(row.ciphertext) },
    deletedAt: optStr(row.deleted_at),
  }
}

function safeRow(db: SqlDatabase, userId: string, safeId: string): SafeRow {
  const row = db.queryOne('SELECT * FROM safes WHERE id = ? AND owner_user_id = ?', [safeId, userId])
  if (!row) throw new SafeError('SAFE_NOT_FOUND')
  return toSafeRow(row)
}

function itemRows(db: SqlDatabase, userId: string, itemIds: string[]): ItemRow[] {
  const unique = [...new Set(itemIds)]
  if (unique.length === 0) return []
  const rows = db.query(
    `SELECT * FROM secure_items WHERE owner_user_id = ? AND id IN (${unique.map(() => '?').join(', ')})`,
    [userId, ...unique],
  )
  if (rows.length !== unique.length) throw new SafeError('ITEM_NOT_FOUND')
  return rows.map(toItemRow)
}

function pkAad(userId: string) {
  return aad('moliya.pk', userId)
}

function recoveryAad(userId: string) {
  return aad('moliya.pk-recovery', userId)
}

function metaAad(userId: string) {
  return aad('moliya.user-meta', userId)
}

function safeKeyAad(userId: string, safeId: string, version: number) {
  return aad('moliya.safe-key', userId, safeId, version)
}

function safeMetaAad(userId: string, safeId: string, version: number) {
  return aad('moliya.safe-meta', userId, safeId, version)
}

function itemAad(userId: string, safeId: string, itemId: string, version: number) {
  return aad('moliya.item', userId, safeId, itemId, version)
}

function pickOne<T extends number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback
}

function normalizeUserMeta(value: unknown, safeIds: string[]): UserSafeMeta {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const order = Array.isArray(source.order) ? source.order.filter((id): id is string => typeof id === 'string' && safeIds.includes(id)) : []
  for (const id of safeIds) if (!order.includes(id)) order.push(id)
  const defaultSafeId = typeof source.defaultSafeId === 'string' && safeIds.includes(source.defaultSafeId) ? source.defaultSafeId : (order[0] ?? '')
  return {
    v: 1,
    order,
    defaultSafeId,
    autoLockMinutes: pickOne(source.autoLockMinutes, AUTO_LOCK_MINUTES, DEFAULT_PREFS.autoLockMinutes),
    clipboardSeconds: pickOne(source.clipboardSeconds, CLIPBOARD_SECONDS, DEFAULT_PREFS.clipboardSeconds),
    revealSeconds: pickOne(source.revealSeconds, REVEAL_SECONDS, DEFAULT_PREFS.revealSeconds),
  }
}

async function sealEvent(
  userId: string,
  personalKey: CryptoKey,
  type: SafeEventType,
  details: { safeId?: string | null; itemId?: string | null; count?: number } = {},
): Promise<EventRow> {
  const id = crypto.randomUUID()
  const event: SafeEvent = { v: 1, type, at: nowIso(), safeId: details.safeId ?? null, itemId: details.itemId ?? null }
  if (details.count !== undefined) event.count = details.count
  const sealed = await sealJson(event, personalKey, aad('moliya.event', userId, id))
  return { id, iv: sealed.iv, ct: sealed.ct }
}

function insertEvents(db: SqlDatabase, userId: string, events: EventRow[]): void {
  for (const event of events) {
    db.exec('INSERT INTO safe_events (id, owner_user_id, iv, ciphertext) VALUES (?, ?, ?, ?)', [event.id, userId, event.iv, event.ct])
  }
  db.exec(
    `DELETE FROM safe_events WHERE owner_user_id = ? AND seq NOT IN (
       SELECT seq FROM safe_events WHERE owner_user_id = ? ORDER BY seq DESC LIMIT ?
     )`,
    [userId, userId, SAFE_LIMITS.events],
  )
}

function writeUserMeta(db: SqlDatabase, userId: string, sealed: Sealed): void {
  db.exec('UPDATE user_keys SET meta_iv = ?, meta_ciphertext = ? WHERE user_id = ?', [sealed.iv, sealed.ct, userId])
}

async function newSafeMaterial(userId: string, personalKey: CryptoKey, safeId: string, meta: SafeMeta, version: number) {
  const key = await generateAesKey(SAFE_KEY_USAGES)
  const wrapped = await wrapWithAad(key, personalKey, safeKeyAad(userId, safeId, version))
  const sealedMeta = await sealJson(meta, key, safeMetaAad(userId, safeId, version))
  const session = await unwrapWithAad(wrapped, personalKey, safeKeyAad(userId, safeId, version), {
    extractable: false,
    usages: SAFE_KEY_USAGES,
  })
  return { key, wrapped, sealedMeta, session }
}

async function safeKey(keyring: SafeKeyring, row: SafeRow): Promise<CryptoKey> {
  const cached = keyring.safeKeys.get(row.id)
  if (cached && cached.version === row.keyVersion) return cached.key
  const key = await unwrapWithAad(row.keyWrap, keyring.personalKey, safeKeyAad(keyring.userId, row.id, row.keyVersion), {
    extractable: false,
    usages: SAFE_KEY_USAGES,
  })
  keyring.safeKeys.set(row.id, { key, version: row.keyVersion })
  return key
}

async function readSafeMeta(keyring: SafeKeyring, row: SafeRow): Promise<SafeMeta> {
  const key = await safeKey(keyring, row)
  return openJson<SafeMeta>(row.meta, key, safeMetaAad(keyring.userId, row.id, row.keyVersion))
}

async function readItem(vault: OpenVault, keyring: SafeKeyring, row: ItemRow, safe?: SafeRow): Promise<SecureItem> {
  const owner = safe ?? safeRow(vault.db, keyring.userId, row.safeId)
  if (owner.keyVersion !== row.keyVersion) throw new SafeError('ITEM_CONFLICT')
  const key = await safeKey(keyring, owner)
  const payload = await openJson<SecureItemPayload>(row.sealed, key, itemAad(keyring.userId, row.safeId, row.id, row.keyVersion))
  return { ...payload, id: row.id, safeId: row.safeId, rev: row.rev, deletedAt: row.deletedAt }
}

async function sealItem(keyring: SafeKeyring, key: CryptoKey, safeId: string, itemId: string, version: number, payload: SecureItemPayload) {
  return sealJson(payload, key, itemAad(keyring.userId, safeId, itemId, version), { sizeClasses: true })
}

function payloadOf(item: SecureItem): SecureItemPayload {
  const { id: _id, safeId: _safeId, rev: _rev, deletedAt: _deletedAt, ...payload } = item
  return payload as SecureItemPayload
}

function isOpen(keyring: SafeKeyring, id: string, meta: SafeMeta | null): boolean {
  return !meta?.requirePassword || keyring.openSafes.has(id)
}

async function writableSafe(vault: OpenVault, keyring: SafeKeyring, safeId: string): Promise<{ row: SafeRow; meta: SafeMeta; key: CryptoKey }> {
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (row.deletedAt) throw new SafeError('SAFE_NOT_FOUND')
  const meta = await readSafeMeta(keyring, row)
  if (meta.archived) throw new SafeError('SAFE_ARCHIVED')
  if (!isOpen(keyring, safeId, meta)) throw new SafeError('SAFE_CLOSED')
  return { row, meta, key: await safeKey(keyring, row) }
}

function countItems(db: SqlDatabase, where: string, params: SqlValue[]): number {
  return Number(db.queryValue(`SELECT COUNT(*) FROM secure_items WHERE ${where}`, params) ?? 0)
}

function assertItemCapacity(db: SqlDatabase, userId: string, safeId: string, adding: number): void {
  if (countItems(db, 'safe_id = ?', [safeId]) + adding > SAFE_LIMITS.itemsPerSafe) throw new SafeError('ITEM_LIMIT')
  if (countItems(db, 'owner_user_id = ?', [userId]) + adding > SAFE_LIMITS.itemsPerUser) throw new SafeError('ITEM_LIMIT')
}

function userState(db: SqlDatabase, userId: string): { mustChange: boolean; passwordChangedAt: string | null } {
  const row = db.queryOne('SELECT must_change_password, password_changed_at FROM users WHERE id = ?', [userId])
  if (!row) throw new AuthError()
  return { mustChange: Number(row.must_change_password) === 1, passwordChangedAt: optStr(row.password_changed_at) }
}

export function getSafeStatus(vault: OpenVault): SafeStatus {
  const keys = readUserKeys(vault.db, vault.user.id)
  const state = userState(vault.db, vault.user.id)
  return {
    initialized: keys !== null,
    mustChangePassword: state.mustChange,
    stale: keys !== null && state.passwordChangedAt !== null && keys.rewrappedAt < state.passwordChangedAt,
    hasRecovery: keys?.recovery != null,
  }
}

async function wrapPersonal(userId: string, personalKey: CryptoKey, password: string) {
  const salt = randomBytes(PK_SALT_BYTES)
  const kdf: KdfParams = { ...CURRENT_KDF }
  const kek = await derivePersonalKek(password, salt, kdf)
  const wrap = await wrapWithAad(personalKey, kek, pkAad(userId))
  return { kdf, salt, wrap, kek }
}

async function wrapRecovery(userId: string, personalKey: CryptoKey) {
  const code = generateRecoveryCode()
  try {
    const salt = randomBytes(RECOVERY_SALT_BYTES)
    const wrap = await wrapWithAad(personalKey, await deriveRecoveryKek(code.bytes, salt), recoveryAad(userId))
    return { display: code.display, salt, wrap }
  } finally {
    code.bytes.fill(0)
  }
}

function sessionPersonalKey(userId: string, wrap: Sealed, kek: CryptoKey): Promise<CryptoKey> {
  return unwrapWithAad(wrap, kek, pkAad(userId), { extractable: false, usages: PERSONAL_KEY_USAGES })
}

async function buildInitialSafes(
  vault: OpenVault,
  password: string,
  options: SetupOptions,
): Promise<{ keyring: SafeKeyring; recoveryCode: string | null; write: Writer }> {
  const userId = vault.user.id
  const extractable = await generateAesKey(PERSONAL_KEY_USAGES)
  const personal = await wrapPersonal(userId, extractable, password)
  const recovery = options.recovery ? await wrapRecovery(userId, extractable) : null
  const personalKey = await sessionPersonalKey(userId, personal.wrap, personal.kek)
  const safeId = crypto.randomUUID()
  const now = nowIso()
  const safeMeta: SafeMeta = {
    v: 1,
    ...validateSafeInput({ name: options.defaultSafeName, description: '', icon: 'vault', color: 'pine', requirePassword: false }),
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
  const material = await newSafeMaterial(userId, personalKey, safeId, safeMeta, 1)
  const meta: UserSafeMeta = { v: 1, order: [safeId], defaultSafeId: safeId, ...DEFAULT_PREFS }
  const sealedMeta = await sealJson(meta, personalKey, metaAad(userId))
  const events = [await sealEvent(userId, personalKey, 'SAFES_INITIALIZED', { safeId })]
  if (recovery) events.push(await sealEvent(userId, personalKey, 'RECOVERY_CREATED'))
  const keyring: SafeKeyring = {
    userId,
    personalKey,
    safeKeys: new Map([[safeId, { key: material.session, version: 1 }]]),
    openSafes: new Set(),
    meta,
    lastAuthAt: Date.now(),
  }
  const write: Writer = (db) => {
    db.exec(
      `INSERT INTO user_keys (user_id, enc_version, kdf, kdf_salt, wrap_iv, wrapped_key, recovery_salt, recovery_iv, recovery_wrapped_key,
         meta_iv, meta_ciphertext, created_at, rewrapped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        ENC_VERSION,
        JSON.stringify(personal.kdf),
        bytesToBase64(personal.salt),
        personal.wrap.iv,
        personal.wrap.ct,
        recovery ? bytesToBase64(recovery.salt) : null,
        recovery?.wrap.iv ?? null,
        recovery?.wrap.ct ?? null,
        sealedMeta.iv,
        sealedMeta.ct,
        now,
        now,
      ],
    )
    db.exec(
      `INSERT INTO safes (id, owner_user_id, enc_version, key_version, key_iv, wrapped_key, meta_iv, meta_ciphertext)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [safeId, userId, ENC_VERSION, material.wrapped.iv, material.wrapped.ct, material.sealedMeta.iv, material.sealedMeta.ct],
    )
    insertEvents(db, userId, events)
  }
  return { keyring, recoveryCode: recovery?.display ?? null, write }
}

export async function initializeSafes(
  vault: OpenVault,
  password: string,
  options: SetupOptions,
): Promise<{ keyring: SafeKeyring; recoveryCode: string | null }> {
  const status = getSafeStatus(vault)
  if (status.mustChangePassword) throw new SafeError('MUST_CHANGE_PASSWORD')
  if (status.initialized) throw new SafeError('SAFES_ALREADY_SET_UP')
  await verifyOwnPassword(vault, password)
  const built = await buildInitialSafes(vault, password, options)
  vault.db.withTransaction(() => built.write(vault.db))
  return { keyring: built.keyring, recoveryCode: built.recoveryCode }
}

async function latestUnlock(vault: OpenVault, userId: string, personalKey: CryptoKey): Promise<string | null> {
  const rows = vault.db.query('SELECT id, iv, ciphertext FROM safe_events WHERE owner_user_id = ? ORDER BY seq DESC LIMIT 100', [userId])
  for (const row of rows) {
    try {
      const event = await openJson<SafeEvent>({ iv: str(row.iv), ct: str(row.ciphertext) }, personalKey, aad('moliya.event', userId, str(row.id)))
      if (event.type === 'SAFES_UNLOCKED') return event.at
    } catch {
      continue
    }
  }
  return null
}

function purgeExpired(db: SqlDatabase, userId: string, now: Date): number {
  const cutoff = new Date(now.getTime() - TRASH_DAYS * DAY_MS).toISOString()
  let removed = 0
  db.exec('DELETE FROM secure_items WHERE owner_user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?', [userId, cutoff])
  removed += changes(db)
  const safes = db.query('SELECT id FROM safes WHERE owner_user_id = ? AND deleted_at IS NOT NULL AND deleted_at < ?', [userId, cutoff])
  for (const row of safes) {
    db.exec('DELETE FROM secure_items WHERE owner_user_id = ? AND safe_id = ?', [userId, row.id])
    removed += changes(db)
    db.exec('DELETE FROM safes WHERE owner_user_id = ? AND id = ?', [userId, row.id])
    removed += 1
  }
  return removed
}

export async function unlockSafes(
  vault: OpenVault,
  secret: UnlockSecret,
  now = new Date(),
): Promise<{ keyring: SafeKeyring; previousUnlockAt: string | null; usedRecovery: boolean }> {
  const userId = vault.user.id
  const status = getSafeStatus(vault)
  if (status.mustChangePassword) throw new SafeError('MUST_CHANGE_PASSWORD')
  const row = readUserKeys(vault.db, userId)
  if (!row) throw new SafeError('SAFES_NOT_SET_UP')

  let rewrap: Awaited<ReturnType<typeof wrapPersonal>> | null = null
  let personalKey: CryptoKey
  const events: EventRow[] = []
  if (secret.kind === 'password') {
    const kek = await derivePersonalKek(secret.password, row.kdfSalt, row.kdf)
    const upgrade = kdfNeedsUpgrade(row.kdf)
    let unwrapped: CryptoKey
    try {
      unwrapped = await unwrapWithAad(row.wrap, kek, pkAad(userId), { extractable: upgrade, usages: PERSONAL_KEY_USAGES })
    } catch {
      if (status.stale) throw new SafeError('SAFES_STALE')
      throw new AuthError()
    }
    if (upgrade) {
      rewrap = await wrapPersonal(userId, unwrapped, secret.password)
      personalKey = await sessionPersonalKey(userId, rewrap.wrap, rewrap.kek)
    } else {
      personalKey = unwrapped
    }
  } else {
    await verifyOwnPassword(vault, secret.current)
    let extractable: CryptoKey
    if (secret.kind === 'previousPassword') {
      const kek = await derivePersonalKek(secret.previous, row.kdfSalt, row.kdf)
      try {
        extractable = await unwrapWithAad(row.wrap, kek, pkAad(userId), { extractable: true, usages: PERSONAL_KEY_USAGES })
      } catch {
        throw new AuthError()
      }
    } else {
      const bytes = parseRecoveryCode(secret.code)
      if (!row.recovery) throw new SafeError('NO_RECOVERY_CODE')
      try {
        const kek = await deriveRecoveryKek(bytes, row.recovery.salt)
        extractable = await unwrapWithAad(row.recovery.wrap, kek, recoveryAad(userId), { extractable: true, usages: PERSONAL_KEY_USAGES })
      } catch {
        throw new ValidationError('RECOVERY_CODE')
      } finally {
        bytes.fill(0)
      }
    }
    rewrap = await wrapPersonal(userId, extractable, secret.current)
    personalKey = await sessionPersonalKey(userId, rewrap.wrap, rewrap.kek)
    events.push(await sealEvent(userId, personalKey, 'PASSWORD_REWRAPPED'))
  }

  const safeRows = vault.db.query('SELECT * FROM safes WHERE owner_user_id = ?', [userId]).map(toSafeRow)
  let metaValue: unknown = null
  try {
    metaValue = await openJson<UserSafeMeta>(row.meta, personalKey, metaAad(userId))
  } catch {
    metaValue = null
  }
  const meta = normalizeUserMeta(
    metaValue,
    safeRows.filter((safe) => !safe.deletedAt).map((safe) => safe.id),
  )
  const keyring: SafeKeyring = { userId, personalKey, safeKeys: new Map(), openSafes: new Set(), meta, lastAuthAt: now.getTime() }
  for (const safe of safeRows) {
    try {
      await safeKey(keyring, safe)
    } catch {
      continue
    }
  }
  const previousUnlockAt = await latestUnlock(vault, userId, personalKey)
  events.push(await sealEvent(userId, personalKey, 'SAFES_UNLOCKED'))
  vault.db.withTransaction(() => {
    if (rewrap) {
      vault.db.exec('UPDATE user_keys SET kdf = ?, kdf_salt = ?, wrap_iv = ?, wrapped_key = ?, rewrapped_at = ? WHERE user_id = ?', [
        JSON.stringify(rewrap.kdf),
        bytesToBase64(rewrap.salt),
        rewrap.wrap.iv,
        rewrap.wrap.ct,
        now.toISOString(),
        userId,
      ])
    }
    const purged = purgeExpired(vault.db, userId, now)
    insertEvents(vault.db, userId, events)
    if (purged > 0) {
      for (const id of [...keyring.safeKeys.keys()]) {
        if (vault.db.queryValue('SELECT id FROM safes WHERE id = ?', [id]) == null) keyring.safeKeys.delete(id)
      }
    }
  })
  return { keyring, previousUnlockAt, usedRecovery: secret.kind === 'recoveryCode' }
}

export async function confirmRecentAuth(vault: OpenVault, keyring: SafeKeyring, password: string): Promise<void> {
  assertKeyring(vault, keyring)
  const row = readUserKeys(vault.db, keyring.userId)
  if (!row) throw new SafeError('SAFES_NOT_SET_UP')
  try {
    await sessionPersonalKey(keyring.userId, row.wrap, await derivePersonalKek(password, row.kdfSalt, row.kdf))
  } catch {
    throw new AuthError()
  }
  keyring.lastAuthAt = Date.now()
}

export function hasRecentAuth(keyring: SafeKeyring, now = Date.now()): boolean {
  return now - keyring.lastAuthAt <= RECENT_AUTH_MS
}

export function assertRecentAuth(keyring: SafeKeyring, now = Date.now()): void {
  if (!hasRecentAuth(keyring, now)) throw new SafeError('REAUTH_REQUIRED')
}

export async function openSafe(vault: OpenVault, keyring: SafeKeyring, safeId: string, password?: string): Promise<void> {
  assertKeyring(vault, keyring)
  safeRow(vault.db, keyring.userId, safeId)
  if (password !== undefined) await confirmRecentAuth(vault, keyring, password)
  else assertRecentAuth(keyring)
  keyring.openSafes.add(safeId)
}

export function closeSafe(keyring: SafeKeyring, safeId: string): void {
  keyring.openSafes.delete(safeId)
}

export async function listSafes(vault: OpenVault, keyring: SafeKeyring, options: { includeTrashed?: boolean } = {}): Promise<SafeSummary[]> {
  assertKeyring(vault, keyring)
  const rows = vault.db.query(
    `SELECT s.*,
       (SELECT COUNT(*) FROM secure_items i WHERE i.safe_id = s.id AND i.deleted_at IS NULL) AS item_count,
       (SELECT COUNT(*) FROM secure_items i WHERE i.safe_id = s.id AND i.deleted_at IS NOT NULL) AS trashed_count
     FROM safes s WHERE s.owner_user_id = ? ${options.includeTrashed ? '' : 'AND s.deleted_at IS NULL'}`,
    [keyring.userId],
  )
  const summaries: SafeSummary[] = []
  for (const raw of rows) {
    const row = toSafeRow(raw)
    let meta: SafeMeta | null = null
    try {
      meta = await readSafeMeta(keyring, row)
    } catch {
      meta = null
    }
    summaries.push({
      id: row.id,
      meta,
      keyVersion: row.keyVersion,
      itemCount: Number(raw.item_count),
      trashedItemCount: Number(raw.trashed_count),
      deletedAt: row.deletedAt,
      isDefault: keyring.meta.defaultSafeId === row.id,
      open: isOpen(keyring, row.id, meta),
    })
  }
  const position = (id: string) => {
    const index = keyring.meta.order.indexOf(id)
    return index < 0 ? Number.MAX_SAFE_INTEGER : index
  }
  return summaries.sort((left, right) => position(left.id) - position(right.id) || (left.meta?.createdAt ?? '').localeCompare(right.meta?.createdAt ?? ''))
}

async function updateUserMeta(vault: OpenVault, keyring: SafeKeyring, next: UserSafeMeta, extra: EventRow[] = [], writer?: Writer) {
  const sealed = await sealJson(next, keyring.personalKey, metaAad(keyring.userId))
  vault.db.withTransaction(() => {
    writer?.(vault.db)
    writeUserMeta(vault.db, keyring.userId, sealed)
    insertEvents(vault.db, keyring.userId, extra)
  })
  keyring.meta = next
}

export async function createSafe(vault: OpenVault, keyring: SafeKeyring, input: SafeInput): Promise<string> {
  assertKeyring(vault, keyring)
  const clean = validateSafeInput(input)
  const count = Number(vault.db.queryValue('SELECT COUNT(*) FROM safes WHERE owner_user_id = ?', [keyring.userId]) ?? 0)
  if (count >= SAFE_LIMITS.safesPerUser) throw new SafeError('SAFE_LIMIT')
  const safeId = crypto.randomUUID()
  const now = nowIso()
  const meta: SafeMeta = { v: 1, ...clean, archived: false, createdAt: now, updatedAt: now }
  const material = await newSafeMaterial(keyring.userId, keyring.personalKey, safeId, meta, 1)
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'SAFE_CREATED', { safeId })
  await updateUserMeta(vault, keyring, { ...keyring.meta, order: [...keyring.meta.order, safeId] }, [event], (db) => {
    db.exec(
      `INSERT INTO safes (id, owner_user_id, enc_version, key_version, key_iv, wrapped_key, meta_iv, meta_ciphertext)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [safeId, keyring.userId, ENC_VERSION, material.wrapped.iv, material.wrapped.ct, material.sealedMeta.iv, material.sealedMeta.ct],
    )
  })
  keyring.safeKeys.set(safeId, { key: material.session, version: 1 })
  if (meta.requirePassword) keyring.openSafes.add(safeId)
  return safeId
}

export async function updateSafe(
  vault: OpenVault,
  keyring: SafeKeyring,
  safeId: string,
  input: Partial<SafeInput> & { archived?: boolean },
): Promise<void> {
  assertKeyring(vault, keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (row.deletedAt) throw new SafeError('SAFE_NOT_FOUND')
  const current = await readSafeMeta(keyring, row)
  const clean = validateSafeInput({ ...current, ...input })
  const next: SafeMeta = { ...current, ...clean, archived: input.archived ?? current.archived, updatedAt: nowIso() }
  const key = await safeKey(keyring, row)
  const sealed = await sealJson(next, key, safeMetaAad(keyring.userId, safeId, row.keyVersion))
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'SAFE_UPDATED', { safeId })
  vault.db.withTransaction(() => {
    vault.db.exec('UPDATE safes SET meta_iv = ?, meta_ciphertext = ? WHERE id = ? AND owner_user_id = ? AND key_version = ?', [
      sealed.iv,
      sealed.ct,
      safeId,
      keyring.userId,
      row.keyVersion,
    ])
    if (changes(vault.db) !== 1) throw new SafeError('ITEM_CONFLICT')
    insertEvents(vault.db, keyring.userId, [event])
  })
}

export async function reorderSafes(vault: OpenVault, keyring: SafeKeyring, orderedIds: string[]): Promise<void> {
  assertKeyring(vault, keyring)
  const ids = vault.db.query('SELECT id FROM safes WHERE owner_user_id = ?', [keyring.userId]).map((row) => str(row.id))
  await updateUserMeta(vault, keyring, normalizeUserMeta({ ...keyring.meta, order: orderedIds }, ids))
}

export async function setDefaultSafe(vault: OpenVault, keyring: SafeKeyring, safeId: string): Promise<void> {
  assertKeyring(vault, keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (row.deletedAt) throw new SafeError('SAFE_NOT_FOUND')
  await updateUserMeta(vault, keyring, { ...keyring.meta, defaultSafeId: safeId })
}

async function moveMaterial(vault: OpenVault, keyring: SafeKeyring, rows: ItemRow[], target: { row: SafeRow; key: CryptoKey }, copy: boolean) {
  const now = nowIso()
  const out: { source: ItemRow; id: string; sealed: Sealed }[] = []
  for (const source of rows) {
    const item = await readItem(vault, keyring, source)
    const id = copy ? crypto.randomUUID() : source.id
    const payload = copy ? { ...payloadOf(item), createdAt: now, updatedAt: now } : payloadOf(item)
    out.push({ source, id, sealed: await sealItem(keyring, target.key, target.row.id, id, target.row.keyVersion, payload) })
  }
  return out
}

function writeMoves(db: SqlDatabase, userId: string, targetSafe: SafeRow, moves: { source: ItemRow; id: string; sealed: Sealed }[]): void {
  for (const move of moves) {
    db.exec(
      `UPDATE secure_items SET safe_id = ?, key_version = ?, iv = ?, ciphertext = ?, rev = rev + 1
       WHERE id = ? AND owner_user_id = ? AND rev = ? AND key_version = ?`,
      [targetSafe.id, targetSafe.keyVersion, move.sealed.iv, move.sealed.ct, move.id, userId, move.source.rev, move.source.keyVersion],
    )
    if (changes(db) !== 1) throw new SafeError('ITEM_CONFLICT')
  }
}

export async function trashSafe(
  vault: OpenVault,
  keyring: SafeKeyring,
  safeId: string,
  options: { withContents: boolean; moveItemsTo?: string },
): Promise<void> {
  assertKeyring(vault, keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (row.deletedAt) throw new SafeError('SAFE_NOT_FOUND')
  const active = vault.db.query('SELECT id FROM safes WHERE owner_user_id = ? AND deleted_at IS NULL', [keyring.userId]).map((r) => str(r.id))
  if (active.length <= 1) throw new SafeError('LAST_SAFE')
  const liveItems = vault.db
    .query('SELECT * FROM secure_items WHERE owner_user_id = ? AND safe_id = ? AND deleted_at IS NULL', [keyring.userId, safeId])
    .map(toItemRow)
  let moves: { source: ItemRow; id: string; sealed: Sealed }[] = []
  let target: { row: SafeRow; key: CryptoKey } | null = null
  if (liveItems.length > 0) {
    if (options.moveItemsTo && options.moveItemsTo !== safeId) {
      const writable = await writableSafe(vault, keyring, options.moveItemsTo)
      target = { row: writable.row, key: writable.key }
      if (countItems(vault.db, 'safe_id = ?', [target.row.id]) + liveItems.length > SAFE_LIMITS.itemsPerSafe) throw new SafeError('ITEM_LIMIT')
      moves = await moveMaterial(vault, keyring, liveItems, target, false)
    } else if (!options.withContents) {
      throw new SafeError('SAFE_NOT_EMPTY')
    }
  }
  const remaining = active.filter((id) => id !== safeId)
  const defaultSafeId = keyring.meta.defaultSafeId === safeId ? remaining[0] : keyring.meta.defaultSafeId
  const events = [await sealEvent(keyring.userId, keyring.personalKey, 'SAFE_TRASHED', { safeId })]
  if (moves.length > 0 && target) events.unshift(await sealEvent(keyring.userId, keyring.personalKey, 'ITEM_MOVED', { safeId: target.row.id, count: moves.length }))
  const now = nowIso()
  await updateUserMeta(vault, keyring, { ...keyring.meta, defaultSafeId }, events, (db) => {
    if (target) writeMoves(db, keyring.userId, target.row, moves)
    db.exec('UPDATE safes SET deleted_at = ? WHERE id = ? AND owner_user_id = ?', [now, safeId, keyring.userId])
  })
  keyring.openSafes.delete(safeId)
}

export async function restoreSafe(vault: OpenVault, keyring: SafeKeyring, safeId: string): Promise<void> {
  assertKeyring(vault, keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (!row.deletedAt) return
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'SAFE_RESTORED', { safeId })
  const order = keyring.meta.order.includes(safeId) ? keyring.meta.order : [...keyring.meta.order, safeId]
  await updateUserMeta(vault, keyring, { ...keyring.meta, order }, [event], (db) => {
    db.exec('UPDATE safes SET deleted_at = NULL WHERE id = ? AND owner_user_id = ?', [safeId, keyring.userId])
  })
}

export async function purgeSafe(vault: OpenVault, keyring: SafeKeyring, safeId: string, typedName: string): Promise<void> {
  assertKeyring(vault, keyring)
  assertRecentAuth(keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (!row.deletedAt) throw new SafeError('SAFE_NOT_FOUND')
  let name: string | null = null
  try {
    name = (await readSafeMeta(keyring, row)).name
  } catch {
    name = null
  }
  if (name !== null && !sameName(name, typedName)) throw new SafeError('CONFIRM_NAME')
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'SAFE_PURGED')
  await updateUserMeta(vault, keyring, { ...keyring.meta, order: keyring.meta.order.filter((id) => id !== safeId) }, [event], (db) => {
    db.exec('DELETE FROM secure_items WHERE owner_user_id = ? AND safe_id = ?', [keyring.userId, safeId])
    db.exec('DELETE FROM safes WHERE owner_user_id = ? AND id = ?', [keyring.userId, safeId])
  })
  keyring.safeKeys.delete(safeId)
  keyring.openSafes.delete(safeId)
}

export async function rotateSafeKey(vault: OpenVault, keyring: SafeKeyring, safeId: string): Promise<void> {
  assertKeyring(vault, keyring)
  assertRecentAuth(keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  if (row.deletedAt) throw new SafeError('SAFE_NOT_FOUND')
  const meta = await readSafeMeta(keyring, row)
  if (!isOpen(keyring, safeId, meta)) throw new SafeError('SAFE_CLOSED')
  const items = vault.db.query('SELECT * FROM secure_items WHERE owner_user_id = ? AND safe_id = ?', [keyring.userId, safeId]).map(toItemRow)
  const version = row.keyVersion + 1
  const material = await newSafeMaterial(keyring.userId, keyring.personalKey, safeId, { ...meta, updatedAt: nowIso() }, version)
  const resealed: { row: ItemRow; sealed: Sealed }[] = []
  for (const item of items) {
    const decrypted = await readItem(vault, keyring, item, row)
    resealed.push({ row: item, sealed: await sealItem(keyring, material.key, safeId, item.id, version, payloadOf(decrypted)) })
  }
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'SAFE_KEY_ROTATED', { safeId, count: items.length })
  vault.db.withTransaction(() => {
    vault.db.exec(
      `UPDATE safes SET key_version = ?, key_iv = ?, wrapped_key = ?, meta_iv = ?, meta_ciphertext = ?
       WHERE id = ? AND owner_user_id = ? AND key_version = ?`,
      [version, material.wrapped.iv, material.wrapped.ct, material.sealedMeta.iv, material.sealedMeta.ct, safeId, keyring.userId, row.keyVersion],
    )
    if (changes(vault.db) !== 1) throw new SafeError('ITEM_CONFLICT')
    for (const item of resealed) {
      vault.db.exec(
        'UPDATE secure_items SET key_version = ?, iv = ?, ciphertext = ?, rev = rev + 1 WHERE id = ? AND owner_user_id = ? AND rev = ? AND key_version = ?',
        [version, item.sealed.iv, item.sealed.ct, item.row.id, keyring.userId, item.row.rev, row.keyVersion],
      )
      if (changes(vault.db) !== 1) throw new SafeError('ITEM_CONFLICT')
    }
    if (countItems(vault.db, 'safe_id = ? AND key_version <> ?', [safeId, version]) > 0) throw new SafeError('ITEM_CONFLICT')
    insertEvents(vault.db, keyring.userId, [event])
  })
  keyring.safeKeys.set(safeId, { key: material.session, version })
}

export async function listItems(
  vault: OpenVault,
  keyring: SafeKeyring,
  safeId: string,
  options: { includeTrashed?: boolean } = {},
): Promise<{ items: SecureItem[]; unreadable: string[] }> {
  assertKeyring(vault, keyring)
  const row = safeRow(vault.db, keyring.userId, safeId)
  let meta: SafeMeta | null = null
  try {
    meta = await readSafeMeta(keyring, row)
  } catch {
    meta = null
  }
  if (!isOpen(keyring, safeId, meta)) throw new SafeError('SAFE_CLOSED')
  const rows = vault.db
    .query(
      `SELECT * FROM secure_items WHERE owner_user_id = ? AND safe_id = ? ${options.includeTrashed ? '' : 'AND deleted_at IS NULL'} ORDER BY rowid`,
      [keyring.userId, safeId],
    )
    .map(toItemRow)
  const items: SecureItem[] = []
  const unreadable: string[] = []
  for (const item of rows) {
    try {
      items.push(await readItem(vault, keyring, item, row))
    } catch {
      unreadable.push(item.id)
    }
  }
  return { items, unreadable }
}

export async function listOpenItems(vault: OpenVault, keyring: SafeKeyring): Promise<{ items: SecureItem[]; unreadable: string[] }> {
  assertKeyring(vault, keyring)
  const items: SecureItem[] = []
  const unreadable: string[] = []
  for (const safe of await listSafes(vault, keyring)) {
    if (!safe.meta || safe.meta.archived || !safe.open) continue
    const result = await listItems(vault, keyring, safe.id)
    items.push(...result.items)
    unreadable.push(...result.unreadable)
  }
  return { items, unreadable }
}

export async function getItem(vault: OpenVault, keyring: SafeKeyring, itemId: string): Promise<SecureItem> {
  assertKeyring(vault, keyring)
  const [row] = itemRows(vault.db, keyring.userId, [itemId])
  const safe = safeRow(vault.db, keyring.userId, row.safeId)
  let meta: SafeMeta | null = null
  try {
    meta = await readSafeMeta(keyring, safe)
  } catch {
    meta = null
  }
  if (!isOpen(keyring, safe.id, meta)) throw new SafeError('SAFE_CLOSED')
  return readItem(vault, keyring, row, safe)
}

export async function createItem(vault: OpenVault, keyring: SafeKeyring, safeId: string, input: SecureItemInput): Promise<string> {
  assertKeyring(vault, keyring)
  const fields = validateItemInput(input)
  const target = await writableSafe(vault, keyring, safeId)
  assertItemCapacity(vault.db, keyring.userId, safeId, 1)
  const id = crypto.randomUUID()
  const now = nowIso()
  const payload = { v: 1, ...fields, favorite: input.favorite === true, createdAt: now, updatedAt: now } as SecureItemPayload
  const sealed = await sealItem(keyring, target.key, safeId, id, target.row.keyVersion, payload)
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'ITEM_CREATED', { safeId, itemId: id })
  vault.db.withTransaction(() => {
    vault.db.exec(
      `INSERT INTO secure_items (id, safe_id, owner_user_id, enc_version, key_version, rev, iv, ciphertext)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, safeId, keyring.userId, ENC_VERSION, target.row.keyVersion, sealed.iv, sealed.ct],
    )
    insertEvents(vault.db, keyring.userId, [event])
  })
  return id
}

async function rewriteItem(
  vault: OpenVault,
  keyring: SafeKeyring,
  itemId: string,
  rev: number,
  change: (current: SecureItem) => SecureItemPayload,
): Promise<void> {
  assertKeyring(vault, keyring)
  const [row] = itemRows(vault.db, keyring.userId, [itemId])
  if (row.rev !== rev) throw new SafeError('ITEM_CONFLICT')
  const target = await writableSafe(vault, keyring, row.safeId)
  const current = await readItem(vault, keyring, row, target.row)
  const payload = change(current)
  const sealed = await sealItem(keyring, target.key, row.safeId, itemId, target.row.keyVersion, payload)
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'ITEM_UPDATED', { safeId: row.safeId, itemId })
  vault.db.withTransaction(() => {
    vault.db.exec(
      'UPDATE secure_items SET iv = ?, ciphertext = ?, rev = rev + 1 WHERE id = ? AND owner_user_id = ? AND rev = ? AND key_version = ?',
      [sealed.iv, sealed.ct, itemId, keyring.userId, rev, target.row.keyVersion],
    )
    if (changes(vault.db) !== 1) throw new SafeError('ITEM_CONFLICT')
    insertEvents(vault.db, keyring.userId, [event])
  })
}

export async function updateItem(vault: OpenVault, keyring: SafeKeyring, itemId: string, rev: number, input: SecureItemInput): Promise<void> {
  const fields = validateItemInput(input)
  await rewriteItem(vault, keyring, itemId, rev, (current) => {
    if (current.kind !== fields.kind) throw new ValidationError('REQUIRED')
    return {
      v: 1,
      ...fields,
      favorite: input.favorite ?? current.favorite,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
    } as SecureItemPayload
  })
}

export async function setFavorite(vault: OpenVault, keyring: SafeKeyring, itemId: string, rev: number, favorite: boolean): Promise<void> {
  await rewriteItem(vault, keyring, itemId, rev, (current) => ({ ...payloadOf(current), favorite }))
}

async function transfer(vault: OpenVault, keyring: SafeKeyring, itemIds: string[], targetSafeId: string, copy: boolean): Promise<string[]> {
  assertKeyring(vault, keyring)
  const rows = itemRows(vault.db, keyring.userId, itemIds).filter((row) => copy || row.safeId !== targetSafeId)
  if (rows.length === 0) return []
  const target = await writableSafe(vault, keyring, targetSafeId)
  for (const safeId of new Set(rows.map((row) => row.safeId))) {
    if (!copy) {
      await writableSafe(vault, keyring, safeId)
      continue
    }
    const source = safeRow(vault.db, keyring.userId, safeId)
    if (!isOpen(keyring, safeId, await readSafeMeta(keyring, source))) throw new SafeError('SAFE_CLOSED')
  }
  if (copy) assertItemCapacity(vault.db, keyring.userId, targetSafeId, rows.length)
  else if (countItems(vault.db, 'safe_id = ?', [targetSafeId]) + rows.length > SAFE_LIMITS.itemsPerSafe) throw new SafeError('ITEM_LIMIT')
  const moves = await moveMaterial(vault, keyring, rows, target, copy)
  const event = await sealEvent(keyring.userId, keyring.personalKey, copy ? 'ITEM_COPIED' : 'ITEM_MOVED', {
    safeId: targetSafeId,
    itemId: rows.length === 1 ? moves[0].id : null,
    count: rows.length,
  })
  vault.db.withTransaction(() => {
    if (copy) {
      for (const move of moves) {
        vault.db.exec(
          `INSERT INTO secure_items (id, safe_id, owner_user_id, enc_version, key_version, rev, iv, ciphertext, deleted_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          [move.id, targetSafeId, keyring.userId, ENC_VERSION, target.row.keyVersion, move.sealed.iv, move.sealed.ct],
        )
      }
    } else {
      writeMoves(vault.db, keyring.userId, target.row, moves)
    }
    insertEvents(vault.db, keyring.userId, [event])
  })
  return moves.map((move) => move.id)
}

export async function moveItems(vault: OpenVault, keyring: SafeKeyring, itemIds: string[], targetSafeId: string): Promise<void> {
  await transfer(vault, keyring, itemIds, targetSafeId, false)
}

export async function copyItems(vault: OpenVault, keyring: SafeKeyring, itemIds: string[], targetSafeId: string): Promise<string[]> {
  return transfer(vault, keyring, itemIds, targetSafeId, true)
}

async function setDeleted(vault: OpenVault, keyring: SafeKeyring, itemIds: string[], deleted: boolean): Promise<void> {
  assertKeyring(vault, keyring)
  const rows = itemRows(vault.db, keyring.userId, itemIds)
  for (const safeId of new Set(rows.map((row) => row.safeId))) {
    const safe = safeRow(vault.db, keyring.userId, safeId)
    const meta = await readSafeMeta(keyring, safe)
    if (meta.archived) throw new SafeError('SAFE_ARCHIVED')
    if (!isOpen(keyring, safeId, meta)) throw new SafeError('SAFE_CLOSED')
  }
  const event = await sealEvent(keyring.userId, keyring.personalKey, deleted ? 'ITEM_TRASHED' : 'ITEM_RESTORED', {
    itemId: rows.length === 1 ? rows[0].id : null,
    count: rows.length,
  })
  const stamp = deleted ? nowIso() : null
  vault.db.withTransaction(() => {
    for (const row of rows) {
      vault.db.exec('UPDATE secure_items SET deleted_at = ? WHERE id = ? AND owner_user_id = ?', [stamp, row.id, keyring.userId])
    }
    insertEvents(vault.db, keyring.userId, [event])
  })
}

export function trashItems(vault: OpenVault, keyring: SafeKeyring, itemIds: string[]): Promise<void> {
  return setDeleted(vault, keyring, itemIds, true)
}

export function restoreItems(vault: OpenVault, keyring: SafeKeyring, itemIds: string[]): Promise<void> {
  return setDeleted(vault, keyring, itemIds, false)
}

export async function purgeItems(vault: OpenVault, keyring: SafeKeyring, itemIds: string[]): Promise<void> {
  assertKeyring(vault, keyring)
  assertRecentAuth(keyring)
  const rows = itemRows(vault.db, keyring.userId, itemIds).filter((row) => row.deletedAt !== null)
  if (rows.length === 0) return
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'ITEM_PURGED', { count: rows.length })
  vault.db.withTransaction(() => {
    for (const row of rows) vault.db.exec('DELETE FROM secure_items WHERE id = ? AND owner_user_id = ?', [row.id, keyring.userId])
    insertEvents(vault.db, keyring.userId, [event])
  })
}

export function purgeExpiredTrash(vault: OpenVault, keyring: SafeKeyring, now = new Date()): number {
  assertKeyring(vault, keyring)
  return vault.db.withTransaction(() => purgeExpired(vault.db, keyring.userId, now))
}

function daysLeft(deletedAt: string, now: Date): number {
  return Math.max(0, TRASH_DAYS - Math.floor((now.getTime() - new Date(deletedAt).getTime()) / DAY_MS))
}

export async function listTrash(
  vault: OpenVault,
  keyring: SafeKeyring,
  now = new Date(),
): Promise<{ safes: (SafeSummary & { daysLeft: number })[]; items: TrashedItem[]; unreadable: string[] }> {
  assertKeyring(vault, keyring)
  const all = await listSafes(vault, keyring, { includeTrashed: true })
  const names = new Map(all.map((safe) => [safe.id, safe.meta?.name ?? null]))
  const safes = all.filter((safe) => safe.deletedAt).map((safe) => ({ ...safe, daysLeft: daysLeft(safe.deletedAt!, now) }))
  const rows = vault.db
    .query('SELECT * FROM secure_items WHERE owner_user_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', [keyring.userId])
    .map(toItemRow)
  const items: TrashedItem[] = []
  const unreadable: string[] = []
  for (const row of rows) {
    const safe = all.find((entry) => entry.id === row.safeId)
    if (safe && !safe.open) continue
    try {
      const item = await readItem(vault, keyring, row)
      items.push({ ...item, daysLeft: daysLeft(row.deletedAt!, now), safeName: names.get(row.safeId) ?? null })
    } catch {
      unreadable.push(row.id)
    }
  }
  return { safes, items, unreadable }
}

export async function listSafeEvents(vault: OpenVault, keyring: SafeKeyring, limit = 200): Promise<(SafeEvent & { id: string })[]> {
  assertKeyring(vault, keyring)
  const rows = vault.db.query('SELECT id, iv, ciphertext FROM safe_events WHERE owner_user_id = ? ORDER BY seq DESC LIMIT ?', [
    keyring.userId,
    limit,
  ])
  const events: (SafeEvent & { id: string })[] = []
  for (const row of rows) {
    try {
      const event = await openJson<SafeEvent>(
        { iv: str(row.iv), ct: str(row.ciphertext) },
        keyring.personalKey,
        aad('moliya.event', keyring.userId, str(row.id)),
      )
      if ((SAFE_EVENT_TYPES as readonly string[]).includes(event.type)) events.push({ ...event, id: str(row.id) })
    } catch {
      continue
    }
  }
  return events
}

export async function updateSafePrefs(vault: OpenVault, keyring: SafeKeyring, prefs: Partial<SafePrefs>): Promise<void> {
  assertKeyring(vault, keyring)
  const next: UserSafeMeta = {
    ...keyring.meta,
    autoLockMinutes: pickOne(prefs.autoLockMinutes ?? keyring.meta.autoLockMinutes, AUTO_LOCK_MINUTES, keyring.meta.autoLockMinutes),
    clipboardSeconds: pickOne(prefs.clipboardSeconds ?? keyring.meta.clipboardSeconds, CLIPBOARD_SECONDS, keyring.meta.clipboardSeconds),
    revealSeconds: pickOne(prefs.revealSeconds ?? keyring.meta.revealSeconds, REVEAL_SECONDS, keyring.meta.revealSeconds),
  }
  await updateUserMeta(vault, keyring, next)
}

export async function createRecoveryCode(vault: OpenVault, keyring: SafeKeyring, password: string): Promise<string> {
  assertKeyring(vault, keyring)
  const row = readUserKeys(vault.db, keyring.userId)
  if (!row) throw new SafeError('SAFES_NOT_SET_UP')
  let extractable: CryptoKey
  try {
    const kek = await derivePersonalKek(password, row.kdfSalt, row.kdf)
    extractable = await unwrapWithAad(row.wrap, kek, pkAad(keyring.userId), { extractable: true, usages: PERSONAL_KEY_USAGES })
  } catch {
    throw new AuthError()
  }
  const recovery = await wrapRecovery(keyring.userId, extractable)
  const event = await sealEvent(keyring.userId, keyring.personalKey, 'RECOVERY_CREATED')
  vault.db.withTransaction(() => {
    vault.db.exec('UPDATE user_keys SET recovery_salt = ?, recovery_iv = ?, recovery_wrapped_key = ? WHERE user_id = ?', [
      bytesToBase64(recovery.salt),
      recovery.wrap.iv,
      recovery.wrap.ct,
      keyring.userId,
    ])
    insertEvents(vault.db, keyring.userId, [event])
  })
  keyring.lastAuthAt = Date.now()
  return recovery.display
}

export async function preparePasswordRewrap(
  vault: OpenVault,
  current: string,
  next: string,
): Promise<((db: SqlDatabase, changedAt: string) => void) | null> {
  const userId = vault.user.id
  const row = readUserKeys(vault.db, userId)
  if (!row || userState(vault.db, userId).mustChange) return null
  let extractable: CryptoKey
  try {
    const kek = await derivePersonalKek(current, row.kdfSalt, row.kdf)
    extractable = await unwrapWithAad(row.wrap, kek, pkAad(userId), { extractable: true, usages: PERSONAL_KEY_USAGES })
  } catch {
    return null
  }
  const rewrap = await wrapPersonal(userId, extractable, next)
  return (db, changedAt) => {
    db.exec('UPDATE user_keys SET kdf = ?, kdf_salt = ?, wrap_iv = ?, wrapped_key = ?, rewrapped_at = ? WHERE user_id = ?', [
      JSON.stringify(rewrap.kdf),
      bytesToBase64(rewrap.salt),
      rewrap.wrap.iv,
      rewrap.wrap.ct,
      changedAt,
      userId,
    ])
  }
}

export async function resetSafes(
  vault: OpenVault,
  password: string,
  typed: string,
  options: SetupOptions,
): Promise<{ keyring: SafeKeyring; recoveryCode: string | null }> {
  if (typed.trim() !== 'RESET') throw new SafeError('CONFIRM_RESET')
  const status = getSafeStatus(vault)
  if (status.mustChangePassword) throw new SafeError('MUST_CHANGE_PASSWORD')
  await verifyOwnPassword(vault, password)
  const built = await buildInitialSafes(vault, password, options)
  const userId = vault.user.id
  vault.db.withTransaction(() => {
    vault.db.exec('DELETE FROM safe_events WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM secure_items WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM safes WHERE owner_user_id = ?', [userId])
    vault.db.exec('DELETE FROM user_keys WHERE user_id = ?', [userId])
    built.write(vault.db)
  })
  return { keyring: built.keyring, recoveryCode: built.recoveryCode }
}
