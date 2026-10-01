import { execFile } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { SqlDatabase } from '../../src/db/sqlite'
import { createVault, sealVault } from '../../src/services/auth.service'
import { backupFileText } from '../../src/services/backup.service'
import { FIXTURE_ROOT, fixtureByPath, readFixture, readManifest } from '../support/fixtures'

const run = promisify(execFile)
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/moliya-decrypt.mjs')
const work = mkdtempSync(join(tmpdir(), 'moliya-cli-'))

afterAll(() => rmSync(work, { recursive: true, force: true }))

function cli(args: string[], password?: string) {
  return run(process.execPath, [CLI, ...args], { env: { ...process.env, MOLIYA_PASSWORD: password ?? '' } })
}

describe.each(readManifest().map((entry) => [entry.path, readFixture(entry)] as const))('moliya-decrypt %s', (path, fixture) => {
  const input = resolve(FIXTURE_ROOT, `${path}.moliya`)

  it('lists the users and format without a password', async () => {
    const { stdout } = await cli([input, '--list'])
    const info = JSON.parse(stdout)
    expect(info.backupFormat).toBe(fixture.backupFormat)
    expect(info.appVersion).toBe(fixture.producedBy)
    expect(info.users.map((user: { email: string }) => user.email).sort()).toEqual(fixture.expected.users.map((user) => user.email).sort())
    expect(info.pendingCodes).toEqual((fixture.expected.grants?.pending ?? []).map(({ kind, email }) => ({ kind, email })))
    const grants = fixture.expected.grants
    for (const grant of grants ? [...grants.pending, ...grants.used, ...grants.revoked] : []) expect(stdout).not.toContain(grant.code)
    expect(stdout).not.toMatch(/salt|iv"|wrappedDek|verifier/)
  })

  it('writes a plain SQLite database with every record and no password material', async () => {
    const out = join(work, `${path.replace('/', '-')}.sqlite`)
    const user = fixture.expected.users[fixture.expected.users.length - 1]
    const { stdout } = await cli([input, '--email', user.email, '--out', out], user.password)
    expect(stdout).toContain(`${fixture.expected.transactions.length} records`)
    const db = await SqlDatabase.openBytes(new Uint8Array(readFileSync(out)))
    try {
      expect(db.queryValue('SELECT COUNT(*) FROM transactions')).toBe(fixture.expected.transactions.length)
      expect(db.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> '' OR salt <> ''")).toBe(0)
      if (fixture.schemaVersion >= 3) {
        for (const table of ['user_keys', 'safes', 'secure_items', 'safe_events']) expect(db.queryValue(`SELECT COUNT(*) FROM ${table}`), table).toBe(0)
      }
      if (fixture.schemaVersion >= 4) {
        expect(db.queryValue('SELECT COUNT(*) FROM user_totp')).toBe(0)
        expect(db.queryValue("SELECT COUNT(*) FROM access_grants WHERE code_verifier <> ''")).toBe(0)
        expect(Number(db.queryValue('SELECT COUNT(*) FROM access_grants'))).toBeGreaterThan(0)
      }
      const column = fixture.schemaVersion === 1 ? 'CAST(round(amount * 100) AS INTEGER)' : 'amount_minor'
      const amounts = new Map(db.query(`SELECT id, ${column} AS minor FROM transactions`).map((row) => [row.id, row.minor]))
      for (const tx of fixture.expected.transactions) expect(amounts.get(tx.id), tx.id).toBe(tx.amountMinor)
    } finally {
      db.close()
    }
  })

  it.runIf(fixture.expected.safes !== undefined)('keeps the still-encrypted private-safe rows with --keep-keys', async () => {
    const out = join(work, `${path.replace('/', '-')}-keys.sqlite`)
    const user = fixture.expected.users[0]
    await cli([input, '--email', user.email, '--out', out, '--keep-keys'], user.password)
    const db = await SqlDatabase.openBytes(new Uint8Array(readFileSync(out)))
    try {
      expect(Number(db.queryValue('SELECT COUNT(*) FROM secure_items'))).toBeGreaterThan(0)
      expect(Number(db.queryValue('SELECT COUNT(*) FROM user_keys'))).toBe(fixture.expected.safes?.owners.length)
    } finally {
      db.close()
    }
  })

  it.runIf(fixture.expected.signInCheck !== undefined)('keeps the still-encrypted sign-in check rows with --keep-keys', async () => {
    const out = join(work, `${path.replace('/', '-')}-totp.sqlite`)
    const user = fixture.expected.users[0]
    await cli([input, '--email', user.email, '--out', out, '--keep-keys'], user.password)
    const db = await SqlDatabase.openBytes(new Uint8Array(readFileSync(out)))
    try {
      expect(db.queryValue('SELECT COUNT(*) FROM user_totp')).toBe(1)
      expect(String(db.queryValue('SELECT secret_ciphertext FROM user_totp'))).not.toContain(fixture.expected.signInCheck!.secret)
    } finally {
      db.close()
    }
  })

  it('rejects a wrong password without writing anything', async () => {
    const user = fixture.expected.users[0]
    await expect(cli([input, '--email', user.email, '--out', join(work, 'wrong.sqlite')], 'nope')).rejects.toMatchObject({
      stderr: expect.stringContaining('wrong email or password'),
    })
  })
})

describe('moliya-decrypt hardening', () => {
  const path = 'v2/ledger-v2'
  const fixture = fixtureByPath(path)
  const user = fixture.expected.users[0]
  const original = JSON.parse(readFileSync(resolve(FIXTURE_ROOT, `${path}.moliya`), 'utf8'))

  function variant(name: string, change: (file: typeof original) => void): string {
    const file = structuredClone(original)
    change(file)
    const target = join(work, `${name}.moliya`)
    writeFileSync(target, JSON.stringify(file))
    return target
  }

  it('refuses key derivation above the app’s 2,000,000 iterations', async () => {
    const input = variant('slow', (file) => {
      file.wraps[0].kdf.iterations = 2_000_001
    })
    await expect(cli([input, '--list'])).rejects.toMatchObject({ stderr: expect.stringContaining('unsupported key derivation parameters') })
  })

  it('gives the same message for a damaged body as for a wrong password, and writes nothing', async () => {
    const input = variant('damaged', (file) => {
      const body = Buffer.from(file.body.ciphertext, 'base64')
      body[body.length - 1] ^= 1
      file.body.ciphertext = body.toString('base64')
    })
    const damagedOut = join(work, 'damaged.sqlite')
    const damaged = await cli([input, '--email', user.email, '--out', damagedOut], user.password).catch((error: { stderr: string }) => error)
    const wrong = await cli([input, '--email', user.email, '--out', damagedOut], 'not the password').catch((error: { stderr: string }) => error)
    expect(damaged).toMatchObject({ stderr: 'moliya-decrypt: wrong email or password, or the backup is damaged\n' })
    expect(wrong).toMatchObject({ stderr: (damaged as { stderr: string }).stderr })
    expect(existsSync(damagedOut)).toBe(false)
  })

  it('only writes a new 0600 file: refuses an existing one, and with --force replaces it or a symlink without following it', async () => {
    const input = resolve(FIXTURE_ROOT, `${path}.moliya`)
    const out = join(work, 'existing.sqlite')
    writeFileSync(out, 'old', { mode: 0o644 })
    await expect(cli([input, '--email', user.email, '--out', out], user.password)).rejects.toMatchObject({
      stderr: expect.stringContaining('exists; pass --force to overwrite'),
    })
    expect(readFileSync(out, 'utf8')).toBe('old')
    await cli([input, '--email', user.email, '--out', out, '--force'], user.password)
    expect(readFileSync(out).subarray(0, 15).toString('latin1')).toBe('SQLite format 3')
    expect(statSync(out).mode & 0o777).toBe(0o600)

    const target = join(work, 'link-target.txt')
    const link = join(work, 'link.sqlite')
    writeFileSync(target, 'untouched')
    symlinkSync(target, link)
    await cli([input, '--email', user.email, '--out', link, '--force'], user.password)
    expect(readFileSync(target, 'utf8')).toBe('untouched')
    expect(lstatSync(link).isSymbolicLink()).toBe(false)
    expect(statSync(link).mode & 0o777).toBe(0o600)
  })

  it('decrypts a backup whose wraps are bound to their person (1.4.2+), scrubbing in a removed temporary directory', async () => {
    const password = 'Cobalt window anchor 61'
    const created = await createVault({ email: 'bound@example.com', password, displayName: 'Bound', currency: 'USD' })
    let text: string
    try {
      text = backupFileText(await sealVault(created.vault))
    } finally {
      created.vault.db.close()
    }
    expect(JSON.parse(text).wraps[0].aad).toBe('moliya/wrap/v1')
    const input = join(work, 'bound.moliya')
    writeFileSync(input, text)
    const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith('moliya-decrypt-')).length
    const before = leftovers()
    const out = join(work, 'bound.sqlite')
    await cli([input, '--email', 'bound@example.com', '--out', out], password)
    expect(leftovers()).toBe(before)
    const db = await SqlDatabase.openBytes(new Uint8Array(readFileSync(out)))
    try {
      expect(db.queryValue("SELECT COUNT(*) FROM users WHERE password_hash <> '' OR salt <> ''")).toBe(0)
    } finally {
      db.close()
    }
    const relabelled = join(work, 'relabelled.moliya')
    const file = JSON.parse(text)
    file.wraps[0].userId = 'someone-else'
    writeFileSync(relabelled, JSON.stringify(file))
    await expect(cli([relabelled, '--email', 'bound@example.com', '--out', join(work, 'relabelled.sqlite')], password)).rejects.toMatchObject({
      stderr: expect.stringContaining('wrong email or password'),
    })
  })
})
