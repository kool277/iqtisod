#!/usr/bin/env node
// Standalone recovery tool for Moliya backups. Depends only on Node.js (22+) so it keeps
// working without the app, its build, or npm. Specification: docs/data-format.md.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { createInterface } from 'node:readline'
import { webcrypto } from 'node:crypto'

const { subtle } = webcrypto
const SUPPORTED_BACKUP_VERSIONS = [1, 2]
const LEGACY_KDF = { name: 'PBKDF2', hash: 'SHA-256', iterations: 200000 }
const KDF_HASHES = ['SHA-256', 'SHA-384', 'SHA-512']
const ITERATIONS = { min: 100000, max: 10000000 }

const USAGE = `Usage:
  node tools/moliya-decrypt.mjs <backup.moliya> --list
  node tools/moliya-decrypt.mjs <backup.moliya> --email <email> [--out <file.sqlite>] [--keep-keys] [--force]

Decrypts a Moliya backup into a standard SQLite database.
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
  const options = { file: null, email: null, out: null, list: false, keepKeys: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${USAGE}\n`)
      process.exit(0)
    } else if (arg === '--list') options.list = true
    else if (arg === '--keep-keys') options.keepKeys = true
    else if (arg === '--force') options.force = true
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
    })),
    grants: readGrants(file.grants),
    body: { iv: bytes(body?.iv, 'body.iv'), ciphertext: bytes(body?.ciphertext, 'body.ciphertext') },
  }
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
  const wrap = backup.wraps.find((item) => item.email.toLowerCase() === email.trim().toLowerCase())
  if (!wrap) throw new Error(`no user ${email} in this backup`)
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: wrap.salt, iterations: wrap.kdf.iterations, hash: wrap.kdf.hash },
    material,
    256,
  )
  const kek = await subtle.importKey('raw', bits, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  let rawDek
  try {
    rawDek = await subtle.decrypt({ name: 'AES-GCM', iv: wrap.iv }, kek, wrap.wrappedDek)
  } catch {
    throw new Error('wrong email or password')
  }
  const dek = await subtle.importKey('raw', rawDek, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: backup.body.iv }, dek, backup.body.ciphertext))
  if (Buffer.from(plain.subarray(0, 16)).toString('latin1') !== 'SQLite format 3\0') throw new Error('decrypted data is not a SQLite database')
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

async function scrub(path) {
  const DatabaseSync = await openSqlite()
  if (!DatabaseSync) return null
  const db = new DatabaseSync(path)
  try {
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
          users: backup.wraps.map((wrap) => ({ email: wrap.email, kdf: wrap.kdf })),
          pendingCodes: backup.grants,
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
  writeFileSync(out, plain, { mode: 0o600 })
  let summary = null
  if (!options.keepKeys) {
    summary = await scrub(out)
    if (!summary) {
      process.stderr.write(
        'moliya-decrypt: warning: this Node.js has no node:sqlite, so password verifiers, private-safe rows and sign-in check secrets were NOT removed from the output. ' +
          'Use Node.js 22.13 or newer, or treat the file as secret.\n',
      )
    }
  }
  process.stdout.write(
    `Wrote ${out}\n  backup format ${backup.version}, written by Moliya ${backup.appVersion}, schema ${summary?.schema ?? backup.schemaVersion}` +
      `${summary ? `, ${summary.transactions} records` : ''}\n  This file is NOT encrypted. Store it securely.\n`,
  )
}

if (process.argv[1]?.endsWith('moliya-decrypt.mjs')) {
  main().catch((error) => fail(error?.message ?? String(error)))
}
