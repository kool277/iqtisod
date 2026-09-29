import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it } from 'vitest'
import { SqlDatabase } from '../../src/db/sqlite'
import { FIXTURE_ROOT, readFixture, readManifest } from '../support/fixtures'

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
      const column = fixture.schemaVersion === 1 ? 'CAST(round(amount * 100) AS INTEGER)' : 'amount_minor'
      const amounts = new Map(db.query(`SELECT id, ${column} AS minor FROM transactions`).map((row) => [row.id, row.minor]))
      for (const tx of fixture.expected.transactions) expect(amounts.get(tx.id), tx.id).toBe(tx.amountMinor)
    } finally {
      db.close()
    }
  })

  it.runIf(fixture.schemaVersion >= 3)('keeps the still-encrypted private-safe rows with --keep-keys', async () => {
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

  it('rejects a wrong password without writing anything', async () => {
    const user = fixture.expected.users[0]
    await expect(cli([input, '--email', user.email, '--out', join(work, 'wrong.sqlite')], 'nope')).rejects.toMatchObject({
      stderr: expect.stringContaining('wrong email or password'),
    })
  })
})
