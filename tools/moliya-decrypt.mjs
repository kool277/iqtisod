#!/usr/bin/env node
// Standalone recovery tool for Moliya backups. Depends only on Node.js (22+; 24.7+ for backup format 3,
// whose passwords need Argon2id) so it keeps working without the app, its build, or npm.
// Specification: docs/data-format.md.
import { chmodSync, closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import * as nodeCrypto from 'node:crypto'

const { subtle } = nodeCrypto.webcrypto
const SUPPORTED_BACKUP_VERSIONS = [1, 2, 3]
const LEGACY_KDF = { name: 'PBKDF2', hash: 'SHA-256', iterations: 200000 }
const KDF_HASHES = ['SHA-256', 'SHA-384', 'SHA-512']
// Same bounds as the app, so a crafted file cannot make the tool spend minutes on one guess.
const ITERATIONS = { min: 100000, max: 2000000 }
// One message for a wrong password and damaged data, so neither can be told from the other.
export const DECRYPT_FAILED = 'wrong email or password, or the backup is damaged'
const WRAP_AAD_V1 = 'moliya/wrap/v1'

const USAGE = `Usage:
  node tools/moliya-decrypt.mjs <backup.moliya> --list
  node tools/moliya-decrypt.mjs <backup.moliya> --email <email> [--out <file.sqlite>] [--keep-keys] [--force] [--verify]

Decrypts a Moliya backup into a standard SQLite database.
For a backup with per-person keys (format 3, Jaybi 2.0), --verify also checks the signed list
of people and the backup's signature, and exits with status 3 if they do not hold. It then
checks the audit log's signatures; the database is still written when some entries do not
check out, which is reported, with exit status 4.
The password is read from MOLIYA_PASSWORD, or prompted for when unset.
Password verifiers are blanked, and private-safe rows (1.2.0+, still encrypted with each
owner's own key), sign-in check secrets and invite-code verifiers (1.3.0+) are removed from
the output unless --keep-keys is given. Invite and reset codes cannot be used here; --list
shows which are still pending.`

function fail(message, code = 1) {
  process.stderr.write(`moliya-decrypt: ${message}\n`)
  process.exit(code)
}

function parseArgs(argv) {
  const options = { file: null, email: null, out: null, list: false, keepKeys: false, force: false, verify: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else if (arg === '--list') options.list = true
    else if (arg === '--keep-keys') options.keepKeys = true
    else if (arg === '--force') options.force = true
    else if (arg === '--verify') options.verify = true
    else if (arg === '--email') options.email = argv[++index]
    else if (arg === '--out') options.out = argv[++index]
    else if (arg.startsWith('--')) fail(`unknown option ${arg}\n\n${USAGE}`, 2)
    else if (!options.file) options.file = arg
    else fail(`unexpected argument ${arg}\n\n${USAGE}`, 2)
  }
  if (!options.file) fail(USAGE, 2)
  if (!options.list && !options.email) fail('--email is required (use --list to see who can unlock this backup)', 2)
  return options
}

function bytes(text, label) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error(`${label} is not valid base64`)
  }
  return new Uint8Array(Buffer.from(text, 'base64'))
}

function checkKdf(kdf) {
  if (
    !kdf ||
    kdf.name !== 'PBKDF2' ||
    !KDF_HASHES.includes(kdf.hash) ||
    !Number.isSafeInteger(kdf.iterations) ||
    kdf.iterations < ITERATIONS.min ||
    kdf.iterations > ITERATIONS.max
  ) {
    throw new Error(`unsupported key derivation parameters ${JSON.stringify(kdf)}`)
  }
  return kdf
}

export function readBackup(text) {
  const file = JSON.parse(text)
  if (file?.format !== 'moliya-vault') throw new Error('not a Moliya backup (format is not "moliya-vault")')
  if (!SUPPORTED_BACKUP_VERSIONS.includes(file.version)) {
    throw new Error(`backup format ${file.version} is newer than this tool understands (${SUPPORTED_BACKUP_VERSIONS.join(', ')})`)
  }
  if (file.version === 3) return readKeysBackup(file)
  const v1 = file.version === 1
  const recordKdf = v1 ? checkKdf(file.kdf ?? LEGACY_KDF) : null
  const body = v1 ? file.payload : file.body
  if (!v1 && (file.cipher?.name !== 'AES-GCM' || file.cipher?.length !== 256)) throw new Error('unsupported cipher')
  return {
    version: file.version,
    appVersion: v1 ? '1.0.0' : file.appVersion,
    schemaVersion: v1 ? 1 : file.schemaVersion,
    exportedAt: file.exportedAt ?? null,
    wraps: file.wraps.map((wrap, index) => ({
      userId: wrap.userId,
      email: wrap.email,
      kdf: recordKdf ?? checkKdf(wrap.kdf),
      salt: bytes(wrap.salt, `wraps[${index}].salt`),
      iv: bytes(wrap.iv, `wraps[${index}].iv`),
      wrappedDek: bytes(wrap.wrappedDek, `wraps[${index}].wrappedDek`),
      aad: readWrapAad(wrap, index),
    })),
    grants: readGrants(file.grants),
    body: { iv: bytes(body?.iv, 'body.iv'), ciphertext: bytes(body?.ciphertext, 'body.ciphertext') },
  }
}

// Wraps written by 1.4.2+ carry aad: "moliya/wrap/v1" and bind their userId as AES-GCM additional data.
function readWrapAad(wrap, index) {
  if (wrap.aad === undefined) return null
  if (wrap.aad !== WRAP_AAD_V1 || typeof wrap.userId !== 'string') throw new Error(`wraps[${index}].aad is not supported`)
  return new TextEncoder().encode(`${WRAP_AAD_V1}|${wrap.userId}`)
}

// 1.3.0+ backups may carry one-time invite and reset wraps. They only unlock with a code, so the
// tool lists them and never tries them.
function readGrants(grants) {
  if (grants == null) return []
  if (!Array.isArray(grants)) throw new Error('grants is not a list')
  return grants.map((grant, index) => {
    if (grant?.kind !== 'INVITE' && grant?.kind !== 'RESET') throw new Error(`grants[${index}].kind is not supported`)
    if (typeof grant.email !== 'string') throw new Error(`grants[${index}].email is missing`)
    return { kind: grant.kind, email: grant.email }
  })
}

export async function decryptBackup(backup, email, password) {
  if (backup.version === 3) return decryptKeysBackup(backup, email, password)
  const wrap = backup.wraps.find((item) => item.email.toLowerCase() === email.trim().toLowerCase())
  if (!wrap) throw new Error(`no user ${email} in this backup`)
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: wrap.salt, iterations: wrap.kdf.iterations, hash: wrap.kdf.hash },
    material,
    256,
  )
  const kek = await subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  new Uint8Array(bits).fill(0)
  let rawDek
  let plain
  try {
    rawDek = await subtle.decrypt(wrap.aad ? { name: 'AES-GCM', iv: wrap.iv, additionalData: wrap.aad } : { name: 'AES-GCM', iv: wrap.iv }, kek, wrap.wrappedDek)
    const dek = await subtle.importKey('raw', rawDek, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: backup.body.iv }, dek, backup.body.ciphertext))
  } catch {
    throw new Error(DECRYPT_FAILED)
  } finally {
    if (rawDek) new Uint8Array(rawDek).fill(0)
  }
  if (Buffer.from(plain.subarray(0, 16)).toString('latin1') !== 'SQLite format 3\0') {
    plain.fill(0)
    throw new Error(DECRYPT_FAILED)
  }
  return plain
}

async function openSqlite() {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    return DatabaseSync
  } catch {
    return null
  }
}

function scrubFile(DatabaseSync, path) {
  const db = new DatabaseSync(path)
  try {
    // Overwrite freed pages and keep VACUUM's copy in memory rather than in the system temp directory.
    db.exec('PRAGMA secure_delete = ON')
    db.exec('PRAGMA temp_store = MEMORY')
    db.exec("UPDATE users SET password_hash = '', salt = ''")
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('safe_events', 'secure_items', 'safes', 'user_keys', 'user_totp', 'access_grants')")
      .all()
    const present = new Set(tables.map((row) => row.name))
    for (const table of ['safe_events', 'secure_items', 'safes', 'user_keys', 'user_totp']) if (present.has(table)) db.exec(`DELETE FROM ${table}`)
    if (present.has('access_grants')) db.exec("UPDATE access_grants SET code_verifier = ''")
    db.exec('VACUUM')
    const schema = db.prepare('PRAGMA user_version').get()
    const count = db.prepare('SELECT COUNT(*) AS n FROM transactions').get()
    return { schema: Number(Object.values(schema)[0]) || 1, transactions: Number(count.n) }
  } finally {
    db.close()
  }
}

/**
 * Scrubs a copy inside a fresh 0700 directory, so the output path only ever holds the scrubbed database.
 * Returns the scrubbed bytes and a summary, or null when this Node.js has no node:sqlite.
 */
export async function scrubbed(plain) {
  const DatabaseSync = await openSqlite()
  if (!DatabaseSync) return null
  const dir = mkdtempSync(join(tmpdir(), 'moliya-decrypt-'))
  const path = join(dir, 'vault.sqlite')
  try {
    chmodSync(dir, 0o700)
    writeFileSync(path, plain, { mode: 0o600 })
    const summary = scrubFile(DatabaseSync, path)
    return { bytes: new Uint8Array(readFileSync(path)), summary }
  } finally {
    try {
      zeroFile(path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// Through one descriptor, so the zeros land in the same file whose size was read.
function zeroFile(path) {
  let fd
  try {
    fd = openSync(path, 'r+')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  try {
    writeFileSync(fd, new Uint8Array(fstatSync(fd).size))
  } finally {
    closeSync(fd)
  }
}

// 'wx' (O_CREAT | O_EXCL) never follows a symlink or reuses a file, so the output is always a new 0600 file
// even if something appears at that path after the early check; --force removes the old one first.
function writeOutput(out, data, force) {
  if (force) rmSync(out, { force: true })
  try {
    writeFileSync(out, data, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${out} exists; pass --force to overwrite`)
    throw error
  }
}

function prompt(question) {
  return new Promise((resolve) => {
    const input = process.stdin
    const rl = createInterface({ input, output: process.stderr, terminal: true })
    rl._writeToOutput = (text) => {
      if (text.includes(question)) process.stderr.write(text)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stderr.write('\n')
      resolve(answer)
    })
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.file)) fail(`${options.file} does not exist`)
  let backup
  try {
    backup = readBackup(readFileSync(options.file, 'utf8'))
  } catch (error) {
    fail(error.message)
  }
  if (options.list) {
    process.stdout.write(
      `${JSON.stringify(
        {
          file: basename(options.file),
          backupFormat: backup.version,
          appVersion: backup.appVersion,
          schemaVersion: backup.schemaVersion,
          exportedAt: backup.exportedAt,
          users: backup.version === 3 ? backup.identities.map((blob) => ({ email: blob.email, kdf: blob.kdf })) : backup.wraps.map((wrap) => ({ email: wrap.email, kdf: wrap.kdf })),
          pendingCodes: backup.grants,
          ...(backup.version === 3 ? { founderKey: formatFingerprint(backup.founder.fingerprint) } : {}),
        },
        null,
        2,
      )}\n`,
    )
    return
  }
  const out = options.out ?? options.file.replace(/\.moliya$/i, '') + '.sqlite'
  if (existsSync(out) && !options.force) fail(`${out} exists; pass --force to overwrite`)
  const password = process.env.MOLIYA_PASSWORD ?? (await prompt(`Password for ${options.email}: `))
  let plain
  try {
    plain = await decryptBackup(backup, options.email, password)
  } catch (error) {
    fail(error.message)
  }
  if (options.verify) {
    if (backup.version !== 3) fail('--verify needs a backup with per-person keys (format 3)', 2)
    let problem
    try {
      problem = await verifyKeysBackup(backup, plain)
    } catch (error) {
      plain.fill(0)
      fail(error.message)
    }
    if (problem.problem) {
      plain.fill(0)
      fail(`verification failed: ${problem.problem}`, 3)
    }
    process.stderr.write(`moliya-decrypt: signed list of people and backup signature verified (founder key ${formatFingerprint(backup.founder.fingerprint)})\n`)
    const audit = problem.audit
    if (audit.problems.length === 0) {
      process.stderr.write(`moliya-decrypt: audit log verified: ${audit.verified} signed entries${audit.legacy ? `, and ${audit.legacy} from before entries were signed` : ''}\n`)
    } else {
      const [first] = audit.problems
      process.stderr.write(`moliya-decrypt: warning: ${audit.problems.length} audit log entries do not check out, the first at entry ${first.seq} (${first.kinds.join(', ')})\n`)
      process.exitCode = 4
    }
  }
  let summary = null
  try {
    const clean = options.keepKeys ? null : await scrubbed(plain)
    if (clean) {
      summary = clean.summary
      try {
        writeOutput(out, clean.bytes, options.force)
      } finally {
        clean.bytes.fill(0)
      }
    } else {
      if (!options.keepKeys) {
        process.stderr.write(
          'moliya-decrypt: warning: this Node.js has no node:sqlite, so password verifiers, private-safe rows and sign-in check secrets were NOT removed from the output. ' +
            'Use Node.js 22.13 or newer, or treat the file as secret.\n',
        )
      }
      writeOutput(out, plain, options.force)
    }
  } finally {
    plain.fill(0)
  }
  process.stdout.write(
    `Wrote ${out}\n  backup format ${backup.version}, written by Moliya ${backup.appVersion}, schema ${summary?.schema ?? backup.schemaVersion}` +
      `${summary ? `, ${summary.transactions} records` : ''}\n  This file is NOT encrypted. Store it securely.\n`,
  )
}

// --- Backup format 3: per-person keys (Jaybi 2.0), docs/data-format.md "Record version 3" ---

const SUITE = 'J2-X25519-ED25519'
const ARGON2_BOUNDS = { m: [19456, 262144], t: [2, 10], p: [1, 4] }
const CHUNK_SIZE = { min: 4096, max: 64 * 1024 * 1024 }
const MAX_CHUNKS = 4096
const LABELS = {
  identityWrap: 'moliya/v2/identity-wrap',
  dekWrap: 'moliya/v2/dek-wrap',
  dekWrapAad: 'moliya/v2/dek-wrap-aad',
  roster: 'moliya/v2/roster',
  audit: 'moliya/v2/audit',
  header: 'moliya/v2/header',
  binding: 'moliya/v2/binding',
  chunk: 'moliya/v2/chunk',
  body: 'moliya/v2/body',
}
const encoder = new TextEncoder()

/** RFC 8785 JSON canonicalization for what Jaybi signs: objects, arrays, strings, safe integers, booleans and null. */
export function canonicalize(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('only safe integers can be canonicalized')
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalize(item)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined)
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    return `{${entries.map(([key, item]) => `${canonicalize(key)}:${canonicalize(item)}`).join(',')}}`
  }
  throw new Error('value cannot be canonicalized')
}

function signedBytes(label, payload) {
  const head = encoder.encode(label)
  const body = encoder.encode(canonicalize(payload))
  const out = new Uint8Array(head.length + 1 + body.length)
  out.set(head, 0)
  out.set(body, head.length + 1)
  return out
}

async function sha256Hex(bytes) {
  return Buffer.from(await subtle.digest('SHA-256', bytes)).toString('hex')
}

function formatFingerprint(fingerprint) {
  return (fingerprint.slice(0, 24).toUpperCase().match(/.{1,4}/g) ?? []).join(' ')
}

function within(value, [min, max]) {
  return Number.isSafeInteger(value) && value >= min && value <= max
}

function checkArgon2(kdf, label) {
  if (!kdf || kdf.name !== 'Argon2id' || !within(kdf.m, ARGON2_BOUNDS.m) || !within(kdf.t, ARGON2_BOUNDS.t) || !within(kdf.p, ARGON2_BOUNDS.p) || kdf.len !== 32 || kdf.v !== 19) {
    throw new Error(`${label}: unsupported key derivation parameters ${JSON.stringify(kdf)}`)
  }
  return kdf
}

function b64(text, label, size) {
  const value = bytes(text, label)
  if (size !== undefined && value.length !== size) throw new Error(`${label} has the wrong length`)
  return value
}

function readKeysBackup(file) {
  if (file.suite !== SUITE) throw new Error(`unsupported key suite ${JSON.stringify(file.suite)}`)
  if (file.cipher?.name !== 'AES-GCM' || file.cipher?.length !== 256) throw new Error('unsupported cipher')
  if (typeof file.vaultId !== 'string' || !Number.isSafeInteger(file.epoch) || file.epoch < 1) throw new Error('vaultId or epoch is missing')
  const identities = Object.values(file.identities ?? {}).map((blob, index) => {
    if (blob?.v !== 2 || blob.suite !== SUITE || typeof blob.memberId !== 'string' || typeof blob.email !== 'string') throw new Error(`identities[${index}] is not supported`)
    return {
      memberId: blob.memberId,
      email: blob.email,
      kdf: checkArgon2(blob.kdf, `identities[${index}]`),
      salt: b64(blob.salt, `identities[${index}].salt`, 16),
      iv: b64(blob.iv, `identities[${index}].iv`, 12),
      sealed: b64(blob.sealed, `identities[${index}].sealed`),
      encPub: blob.encPub,
      sigPub: blob.sigPub,
    }
  })
  if (identities.length === 0) throw new Error('no one can unlock this backup')
  const body = file.body ?? {}
  const { chunkSize, length } = body
  if (!within(chunkSize, [CHUNK_SIZE.min, CHUNK_SIZE.max]) || (chunkSize & (chunkSize - 1)) !== 0 || !Number.isSafeInteger(length) || length < 1) throw new Error('body is not supported')
  const count = Math.ceil(length / chunkSize)
  if (count > MAX_CHUNKS || !Array.isArray(body.chunks) || body.chunks.length !== count) throw new Error('body chunks do not match its length')
  const ciphertext = bytes(body.ciphertext, 'body.ciphertext')
  if (ciphertext.length !== length + 16 * count) throw new Error('body ciphertext has the wrong length')
  const chunks = []
  for (let index = 0, offset = 0; index < count; index += 1) {
    const size = Math.min(chunkSize, length - index * chunkSize) + 16
    chunks.push({ iv: b64(body.chunks[index], `body.chunks[${index}]`, 12), ciphertext: ciphertext.subarray(offset, offset + size) })
    offset += size
  }
  const audit = file.audit && Number.isSafeInteger(file.audit.seq) && file.audit.seq >= 0 && /^[0-9a-f]{64}$/.test(file.audit.hash) ? { seq: file.audit.seq, hash: file.audit.hash } : null
  return {
    version: 3,
    appVersion: file.appVersion,
    schemaVersion: file.schemaVersion,
    exportedAt: file.exportedAt ?? null,
    createdAt: typeof file.createdAt === 'string' && file.createdAt.length > 0 ? file.createdAt : null,
    updatedAt: file.updatedAt,
    audit,
    vaultId: file.vaultId,
    epoch: file.epoch,
    founder: file.founder,
    roster: file.roster,
    sig: file.sig,
    identities,
    dekWraps: file.dekWraps ?? {},
    grants: readGrants(file.grants),
    body: { chunkSize, length, manifest: body.chunks, seal: { iv: b64(body.seal?.iv, 'body.seal.iv', 12), tag: b64(body.seal?.tag, 'body.seal.tag', 16) }, sealText: body.seal, chunks },
  }
}

async function hkdfAesKey(ikm, salt, info) {
  const material = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(info) }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
}

function argon2id(password, blob) {
  const argon2Sync = nodeCrypto.argon2Sync
  if (typeof argon2Sync !== 'function') throw new Error('backup format 3 needs Node.js 24.7 or newer (for Argon2id); older Node.js still reads formats 1 and 2')
  return argon2Sync('argon2id', { message: Buffer.from(password, 'utf8'), nonce: blob.salt, parallelism: blob.kdf.p, tagLength: 32, memory: blob.kdf.m, passes: blob.kdf.t })
}

/** Three parts, each with a 16-bit length in front: the X25519 pkcs8, the Ed25519 pkcs8, and the 32-byte seed. */
function unpackIdentity(plain) {
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength)
  const parts = []
  let at = 0
  while (at < plain.length && parts.length < 3) {
    if (at + 2 > plain.length) break
    const length = view.getUint16(at)
    if (at + 2 + length > plain.length) break
    parts.push(plain.slice(at + 2, at + 2 + length))
    at += 2 + length
  }
  plain.fill(0)
  if (parts.length !== 3 || at !== plain.length || parts[2].length !== 32) {
    for (const part of parts) part.fill(0)
    throw new Error(DECRYPT_FAILED)
  }
  parts[2].fill(0)
  return { enc: parts[0], sig: parts[1] }
}

async function decryptKeysBackup(backup, email, password) {
  const blob = backup.identities.find((item) => item.email.toLowerCase() === email.trim().toLowerCase())
  if (!blob) throw new Error(`no user ${email} in this backup`)
  const bits = argon2id(password, blob)
  let secret
  try {
    const kek = await hkdfAesKey(bits, new Uint8Array(0), `${LABELS.identityWrap}|kek`)
    const aad = encoder.encode(`${LABELS.identityWrap}|${backup.vaultId}|${blob.memberId}|${SUITE}|${blob.encPub}|${blob.sigPub}`)
    secret = unpackIdentity(new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: blob.iv, additionalData: aad }, kek, blob.sealed)))
  } catch {
    throw new Error(DECRYPT_FAILED)
  } finally {
    bits.fill(0)
  }
  let rawDek
  try {
    const wrap = backup.dekWraps[blob.memberId]
    if (!wrap || wrap.epoch !== backup.epoch || wrap.memberId !== blob.memberId) throw new Error(DECRYPT_FAILED)
    const encPriv = await subtle.importKey('pkcs8', secret.enc, { name: 'X25519' }, false, ['deriveBits'])
    const epk = await subtle.importKey('raw', b64(wrap.epk, 'dekWrap.epk', 32), { name: 'X25519' }, true, [])
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: epk }, encPriv, 256))
    const kek = await hkdfAesKey(shared, b64(wrap.salt, 'dekWrap.salt', 32), `${LABELS.dekWrap}|${SUITE}|${wrap.epk}|${blob.encPub}`)
    shared.fill(0)
    const pubHash = await sha256Hex(b64(blob.encPub, 'encPub', 32))
    const aad = encoder.encode(`${LABELS.dekWrapAad}|${backup.vaultId}|${backup.epoch}|${blob.memberId}|${pubHash}|${SUITE}`)
    rawDek = await subtle.decrypt({ name: 'AES-GCM', iv: b64(wrap.iv, 'dekWrap.iv', 12), additionalData: aad }, kek, b64(wrap.ct, 'dekWrap.ct', 48))
  } catch {
    throw new Error(DECRYPT_FAILED)
  } finally {
    secret.enc.fill(0)
    secret.sig.fill(0)
  }
  const plain = new Uint8Array(backup.body.length)
  try {
    const dek = await subtle.importKey('raw', rawDek, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    const { chunkSize, length, manifest } = backup.body
    // The seal covers the list of chunk IVs, so no chunk from another save can stand in for one of these.
    const sealAad = encoder.encode(`${LABELS.body}|${backup.vaultId}|${backup.epoch}|${canonicalize({ chunkSize, length, chunks: manifest })}`)
    await subtle.decrypt({ name: 'AES-GCM', iv: backup.body.seal.iv, additionalData: sealAad }, dek, backup.body.seal.tag)
    for (let index = 0; index < backup.body.chunks.length; index += 1) {
      const chunk = backup.body.chunks[index]
      const aad = encoder.encode(`${LABELS.chunk}|${backup.vaultId}|${backup.epoch}|${index}|${chunkSize}`)
      const part = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunk.iv, additionalData: aad }, dek, chunk.ciphertext))
      plain.set(part, index * chunkSize)
      part.fill(0)
    }
  } catch {
    plain.fill(0)
    throw new Error(DECRYPT_FAILED)
  } finally {
    new Uint8Array(rawDek).fill(0)
  }
  if (Buffer.from(plain.subarray(0, 16)).toString('latin1') !== 'SQLite format 3\0') {
    plain.fill(0)
    throw new Error(DECRYPT_FAILED)
  }
  return plain
}

async function verifySignature(label, payload, signature, publicKey) {
  try {
    const key = await subtle.importKey('raw', b64(publicKey, 'public key', 32), { name: 'Ed25519' }, true, ['verify'])
    return await subtle.verify({ name: 'Ed25519' }, key, b64(signature, 'signature', 64), signedBytes(label, payload))
  } catch {
    return false
  }
}

function withoutSig(doc) {
  const { sig: _sig, ...rest } = doc
  return rest
}

function bindingBody(fields) {
  const { type, suite, vaultId, memberId, rosterVersion, inviteSigPub, encPub, sigPub, at } = fields
  return { type, suite, vaultId, memberId, rosterVersion, inviteSigPub, encPub, sigPub, at }
}

async function bindingHolds(fields, inviteSig, memberSig) {
  const signed = bindingBody(fields)
  return (await verifySignature(LABELS.binding, signed, inviteSig, signed.inviteSigPub)) && (await verifySignature(LABELS.binding, signed, memberSig, signed.sigPub))
}

// What each role may do and who may write each audit action, as src/rbac/index.ts and src/rbac/audit-policy.ts say;
// tests/unit/audit-policy.test.ts keeps them the same. An Admin may do everything.
export const ROLE_PERMISSIONS = {
  Manager: ['CREATE_TRANSACTION', 'UPDATE_TRANSACTION', 'DELETE_TRANSACTION', 'READ_TRANSACTIONS', 'READ_DASHBOARD'],
  Viewer: ['READ_TRANSACTIONS', 'READ_DASHBOARD'],
}
const MANAGE_USERS = { permission: 'MANAGE_USERS' }
const MANAGE_SETTINGS = { permission: 'MANAGE_SETTINGS' }
const EXPORT_VAULT = { permission: 'EXPORT_VAULT' }
export const AUDIT_POLICY = {
  VAULT_CREATED: MANAGE_USERS,
  VAULT_UPGRADED: MANAGE_USERS,
  VAULT_REPLACED_BY_IMPORT: { permission: 'IMPORT_VAULT' },
  ROSTER_ROLLBACK_ACCEPTED: MANAGE_USERS,
  EPOCH_ROTATED: MANAGE_USERS,
  SCHEMA_MIGRATED: { anyone: true },
  SETTINGS_UPDATED: MANAGE_SETTINGS,
  CATEGORY_CREATED: MANAGE_SETTINGS,
  CATEGORY_UPDATED: MANAGE_SETTINGS,
  CATEGORY_DELETED: MANAGE_SETTINGS,
  GROUP_CREATED: { permission: 'MANAGE_GROUPS' },
  GROUP_DELETED: { permission: 'MANAGE_GROUPS' },
  TRANSACTION_CREATED: { permission: 'CREATE_TRANSACTION' },
  TRANSACTION_UPDATED: { permission: 'UPDATE_TRANSACTION' },
  TRANSACTION_DELETED: { permission: 'DELETE_TRANSACTION' },
  BACKUP_EXPORTED: EXPORT_VAULT,
  DATA_EXPORTED: EXPORT_VAULT,
  PLAINTEXT_EXPORTED: EXPORT_VAULT,
  AUDIT_MARK_RESET: { permission: 'READ_AUDIT' },
  USER_CREATED: MANAGE_USERS,
  USER_UPDATED: MANAGE_USERS,
  USER_PASSWORD_RESET: MANAGE_USERS,
  USER_MUST_CHANGE_PASSWORD: MANAGE_USERS,
  USER_SUSPENDED: MANAGE_USERS,
  USER_REACTIVATED: MANAGE_USERS,
  USER_DELETED: MANAGE_USERS,
  TRANSACTIONS_REASSIGNED: MANAGE_USERS,
  INVITE_CREATED: MANAGE_USERS,
  INVITE_REVOKED: MANAGE_USERS,
  RESET_ISSUED: MANAGE_USERS,
  RESET_REVOKED: MANAGE_USERS,
  CLOCK_FLOOR_RESET: MANAGE_USERS,
  INVITE_ACCEPTED: { anyone: true },
  RESET_COMPLETED: { anyone: true },
  INVITE_EXPIRED: { anyone: true },
  PASSWORD_CHANGED: { self: true },
  CREDENTIALS_UPGRADED: { self: true },
  SIGNIN_FAILURES_SEEN: { self: true },
  TOTP_ENABLED: { self: true },
  TOTP_DISABLED: { self: true },
  TOTP_RECOVERY_USED: { self: true },
  TOTP_CLEARED: { permission: 'MANAGE_USERS', self: true },
}

function auditAllowed(role, row, actor) {
  if (role === 'Admin') return true
  if (!Object.hasOwn(AUDIT_POLICY, row.action)) return false
  const rule = AUDIT_POLICY[row.action]
  if (rule.anyone) return true
  if (rule.self && row.entity_type === 'user' && row.entity_id === actor) return true
  return rule.permission !== undefined && (ROLE_PERMISSIONS[role] ?? []).includes(rule.permission)
}

function auditHash(row) {
  const fields = [row.seq, row.id, row.actor_id, row.action, row.entity_type, row.entity_id, row.details, row.created_at, row.prev_hash]
  return nodeCrypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex')
}

/**
 * The audit log's signatures (docs/data-format.md, "Signed audit entries"): from the first signed entry on, each entry
 * is signed by its actor with the key the roster version it names gives them, whose role there allows the action.
 * Returns the problems by entry, as the app's Audit page shows them.
 */
async function checkAuditLog(backup, docs, bindings, rows, sigRows) {
  const problems = new Map()
  const flag = (seq, kind) => problems.set(seq, [...new Set([...(problems.get(seq) ?? []), kind])])
  const firstSigned = sigRows.length > 0 ? Math.min(...sigRows.map((sig) => sig.seq)) : null
  let previous = '0'.repeat(64)
  let expected = 1
  for (const row of rows) {
    if (row.seq !== expected || row.prev_hash !== previous || auditHash(row) !== row.hash) flag(row.seq, 'CHAIN')
    previous = row.hash
    expected = row.seq + 1
  }
  const present = new Set(rows.map((row) => row.seq))
  for (const sig of sigRows) if (!present.has(sig.seq)) flag(sig.seq, 'ORPHAN')
  // The binding a redeeming entry carries outlives one an admin dropped before folding it into the roster.
  const redeemed = rows.flatMap((row) => {
    if (row.action !== 'INVITE_ACCEPTED' && row.action !== 'RESET_COMPLETED') return []
    try {
      const binding = JSON.parse(row.details)?.binding
      return binding && binding.memberId === row.actor_id ? [binding] : []
    } catch {
      return []
    }
  })
  const keyAt = async (actor, version) => {
    const member = docs[version - 1]?.members.find((item) => item.id === actor)
    if (!member) return null
    if (member.status === 'active') return { sigPub: member.sigPub, role: member.role }
    if (member.status !== 'invited') return null
    for (const binding of [...bindings, ...redeemed]) {
      if (binding.memberId !== actor || binding.inviteSigPub !== member.inviteSigPub || binding.vaultId !== backup.vaultId || binding.suite !== SUITE) continue
      if (await bindingHolds(binding, binding.inviteSig, binding.memberSig)) return { sigPub: binding.sigPub, role: member.role }
    }
    for (let next = version + 1; next <= docs.length; next += 1) {
      const before = docs[next - 2].members.find((item) => item.id === actor)
      if (before?.status !== 'invited' || before.inviteSigPub !== member.inviteSigPub) return null
      const after = docs[next - 1].members.find((item) => item.id === actor)
      if (after?.status === 'active' && after.proof) return { sigPub: after.sigPub, role: member.role }
    }
    return null
  }
  const sigs = new Map(sigRows.map((sig) => [sig.seq, sig]))
  let legacy = 0
  let verified = 0
  let lastVersion = 0
  for (const row of rows) {
    if (firstSigned === null || row.seq < firstSigned) {
      legacy += 1
      continue
    }
    const sig = sigs.get(row.seq)
    if (!sig) {
      flag(row.seq, 'UNSIGNED')
      continue
    }
    if (row.actor_id !== null && row.actor_id !== sig.actor) flag(row.seq, 'ACTOR')
    const doc = docs[sig.roster_version - 1]
    if (!doc || sig.roster_version < lastVersion || sig.epoch !== doc.epoch) flag(row.seq, 'ORDER')
    lastVersion = Math.max(lastVersion, sig.roster_version)
    if (!doc) continue
    const key = await keyAt(sig.actor, sig.roster_version)
    if (!key) {
      flag(row.seq, 'SIGNER')
      continue
    }
    const body = {
      type: 'audit',
      suite: SUITE,
      vaultId: backup.vaultId,
      seq: row.seq,
      prev: row.prev_hash,
      hash: row.hash,
      rosterVersion: sig.roster_version,
      epoch: sig.epoch,
      at: row.created_at,
      actor: sig.actor,
      action: row.action,
      ...(row.seq === firstSigned ? { bridge: true } : {}),
    }
    if (!(await verifySignature(LABELS.audit, body, sig.sig, key.sigPub))) {
      flag(row.seq, 'SIGNATURE')
      continue
    }
    // The admin who signed a roster version that lowers their own role signed the entries of that save with it.
    const before = sig.roster_version > 1 && doc.issuedBy === sig.actor ? docs[sig.roster_version - 2].members.find((item) => item.id === sig.actor) : undefined
    if (!auditAllowed(key.role, row, sig.actor) && !(before && before.status !== 'removed' && before.role === 'Admin')) flag(row.seq, 'ROLE')
    if (!problems.has(row.seq)) verified += 1
  }
  const listed = [...problems].sort(([left], [right]) => left - right).map(([seq, kinds]) => ({ seq, kinds }))
  return { entries: rows.length, signedFrom: firstSigned, legacy, verified, problems: listed }
}

/**
 * The checks of the app's unlock (design 3.8, steps 2–3 and 5) on a decrypted format 3 backup, then its audit
 * signatures (step 6). `problem` blocks, as in the app; `audit` lists entries that do not check out.
 */
export async function verifyKeysBackup(backup, plain) {
  const DatabaseSync = await openSqlite()
  if (!DatabaseSync) throw new Error('--verify needs node:sqlite (Node.js 22.13 or newer)')
  const dir = mkdtempSync(join(tmpdir(), 'moliya-decrypt-'))
  const path = join(dir, 'vault.sqlite')
  let rows
  let bindingRows
  let people
  let profiles
  let auditRows
  let sigRows
  try {
    chmodSync(dir, 0o700)
    writeFileSync(path, plain, { mode: 0o600 })
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      rows = db.prepare('SELECT version, hash, doc FROM roster_versions ORDER BY version').all()
      bindingRows = db.prepare('SELECT member_id, doc FROM key_bindings ORDER BY member_id').all()
      people = db.prepare('SELECT u.id, u.email, r.name AS role, u.group_id AS grp FROM users u JOIN roles r ON r.id = u.role_id').all()
      profiles = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'user_profile:%'").all()
      auditRows = db.prepare('SELECT seq, id, actor_id, action, entity_type, entity_id, details, created_at, prev_hash, hash FROM audit_logs ORDER BY seq').all()
      sigRows = db.prepare('SELECT seq, actor, roster_version, epoch, sig FROM audit_sigs ORDER BY seq').all()
    } finally {
      db.close()
    }
  } finally {
    try {
      zeroFile(path)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const blocked = (problem) => ({ problem, audit: null })
  if (rows.length === 0) return blocked('the backup has no signed list of people')
  const docs = rows.map((row) => JSON.parse(row.doc))
  for (const doc of docs) {
    if (doc?.type !== 'roster' || !Array.isArray(doc.members) || !Number.isSafeInteger(doc.epoch) || doc.epoch < 1) return blocked(`roster version ${doc?.version} is malformed`)
    const ids = doc.members.map((member) => member?.id)
    if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) return blocked(`roster version ${doc.version} lists a member twice`)
    if (doc.members.some((member) => !['active', 'invited', 'removed'].includes(member.status) || !['Admin', 'Manager', 'Viewer'].includes(member.role))) {
      return blocked(`roster version ${doc.version} has an unknown status or role`)
    }
  }
  let previous = null
  let founder = null
  for (let index = 0; index < docs.length; index += 1) {
    const doc = docs[index]
    if (doc.version !== index + 1 || doc.vaultId !== backup.vaultId || doc.suite !== SUITE || doc.prev !== previous) return blocked(`roster version ${index + 1} is out of order`)
    if ((await sha256Hex(encoder.encode(canonicalize(doc)))) !== rows[index].hash) return blocked(`roster version ${doc.version} does not match its stored hash`)
    const members = new Map(doc.members.map((member) => [member.id, member]))
    if (index === 0) {
      const [first] = doc.members
      if (doc.members.length !== 1 || first.status !== 'active' || first.role !== 'Admin' || first.id !== doc.issuedBy || first.proof !== undefined) return blocked('roster version 1 does not name the founder alone')
      if (!(await verifySignature(LABELS.roster, withoutSig(doc), doc.sig, first.sigPub))) return blocked('roster version 1 is not signed by the founder')
      founder = first
    } else {
      if (doc.epoch < docs[index - 1].epoch) return blocked(`roster version ${doc.version} goes back to an older vault key`)
      const before = new Map(docs[index - 1].members.map((member) => [member.id, member]))
      const was = before.get(doc.issuedBy)
      const now = members.get(doc.issuedBy)
      const key = was?.status === 'active' && was.role === 'Admin' ? was.sigPub : was?.status === 'invited' && was.role === 'Admin' && now?.status === 'active' && now.proof ? now.sigPub : null
      if (!key || !(await verifySignature(LABELS.roster, withoutSig(doc), doc.sig, key))) return blocked(`roster version ${doc.version} is not signed by an admin of version ${doc.version - 1}`)
      for (const member of doc.members) {
        if (member.status !== 'active') continue
        const prior = before.get(member.id)
        if (prior?.status === 'active' && prior.encPub === member.encPub && prior.sigPub === member.sigPub && !member.proof) continue
        const proof = member.proof
        const fields = { type: 'binding', suite: SUITE, vaultId: backup.vaultId, memberId: member.id, rosterVersion: proof?.rosterVersion, inviteSigPub: prior?.inviteSigPub, encPub: member.encPub, sigPub: member.sigPub, at: proof?.at }
        if (prior?.status !== 'invited' || !proof || !Number.isSafeInteger(proof.rosterVersion) || proof.rosterVersion > doc.version - 1 || !(await bindingHolds(fields, proof.inviteSig, proof.memberSig))) {
          return blocked(`roster version ${doc.version} adds keys for ${member.email} without an invite`)
        }
      }
    }
    previous = await sha256Hex(encoder.encode(canonicalize(doc)))
  }
  const latest = docs[docs.length - 1]
  if (backup.founder?.memberId !== founder.id || backup.founder?.sigPub !== founder.sigPub || backup.founder?.fingerprint !== (await sha256Hex(b64(founder.sigPub, 'founder key', 32))).slice(0, 32)) return blocked('the backup names another founder than its roster')
  if (backup.roster?.version !== latest.version || backup.roster?.hash !== previous) return blocked('the backup does not name its latest roster version')
  if (backup.epoch !== latest.epoch) return blocked('the backup and its roster disagree about the vault key')
  const active = new Map(latest.members.filter((member) => member.status === 'active').map((member) => [member.id, member]))
  for (const row of bindingRows) {
    const binding = JSON.parse(row.doc)
    const invited = latest.members.find((member) => member.id === binding.memberId)
    if (binding.memberId !== row.member_id || invited?.status !== 'invited' || binding.inviteSigPub !== invited.inviteSigPub || binding.vaultId !== backup.vaultId || !(await bindingHolds(binding, binding.inviteSig, binding.memberSig))) {
      return blocked(`the key binding for ${row.member_id} is not valid`)
    }
    active.set(binding.memberId, { ...invited, encPub: binding.encPub, sigPub: binding.sigPub })
  }
  const users = new Map(people.map((person) => [person.id, person]))
  const statusOf = new Map(
    profiles.map((row) => {
      let status = 'ACTIVE'
      try {
        const value = JSON.parse(row.value)
        if (value?.status === 'SUSPENDED' || value?.status === 'FORMER') status = value.status
      } catch {
        // A damaged profile reads as active, as in the app.
      }
      return [row.key.slice('user_profile:'.length), status]
    }),
  )
  for (const member of active.values()) {
    const person = users.get(member.id)
    if (!person || person.email !== member.email || person.role !== member.role || (person.grp ?? null) !== member.group) return blocked(`${member.email} in the database does not match the signed list of people`)
    if ((statusOf.get(member.id) ?? 'ACTIVE') !== 'ACTIVE') return blocked(`${member.email} is suspended or a former member but still in the signed list of people`)
  }
  const signer = active.get(backup.sig?.by)
  const header = {
    version: 3,
    appVersion: backup.appVersion,
    schemaVersion: backup.schemaVersion,
    createdAt: backup.createdAt,
    updatedAt: backup.updatedAt,
    cipher: { name: 'AES-GCM', length: 256 },
    ...(backup.audit ? { audit: backup.audit } : {}),
    suite: SUITE,
    vaultId: backup.vaultId,
    epoch: backup.epoch,
    founder: { memberId: backup.founder.memberId, sigPub: backup.founder.sigPub, fingerprint: backup.founder.fingerprint },
    roster: { version: backup.roster.version, hash: backup.roster.hash },
    body: { chunkSize: backup.body.chunkSize, length: backup.body.length, chunks: backup.body.manifest, seal: { iv: backup.body.sealText.iv, tag: backup.body.sealText.tag } },
  }
  if (!signer || backup.sig?.alg !== 'Ed25519' || !(await verifySignature(LABELS.header, header, backup.sig.value, signer.sigPub))) return blocked('the backup is not signed by a member of its roster')
  const bindings = bindingRows.map((row) => JSON.parse(row.doc))
  return { problem: null, audit: await checkAuditLog(backup, docs, bindings, auditRows, sigRows) }
}

if (process.argv[1]?.endsWith('moliya-decrypt.mjs')) {
  main().catch((error) => fail(error?.message ?? String(error)))
}
