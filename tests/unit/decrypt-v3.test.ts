import 'fake-indexeddb/auto'
import * as nodeCrypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatFingerprint } from '../../src/crypto/sign'
import { readVault, writeVault } from '../../src/db/storage'
import { SqlDatabase } from '../../src/db/sqlite'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { backupFileText } from '../../src/services/backup.service'
import { createInvite, redeemGrant } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { commitSealed, confirmKeysSession } from '../../src/services/v2/session'
import { createKeysVault } from '../../src/services/v2/vault'
import { FIXTURE_ROOT, fixtureByPath } from '../support/fixtures'
import { memoryStorage } from '../support/memory-storage'

vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

const run = promisify(execFile)
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../../tools/moliya-decrypt.mjs')
const work = mkdtempSync(join(tmpdir(), 'moliya-cli-v3-'))
const argon2Sync = (nodeCrypto as unknown as { argon2Sync?: unknown }).argon2Sync

const FOUNDER = { email: 'founder@cli.test', password: 'founder-cli-password-1' }
const MEMBER = { email: 'member@cli.test', password: 'member-cli-password-1' }

let file = ''
let fingerprint = ''

function cli(args: string[], password?: string) {
  return run(process.execPath, [CLI, ...args], { env: { ...process.env, MOLIYA_PASSWORD: password ?? '' } })
}

async function failure(args: string[], password?: string): Promise<{ code: number; stderr: string }> {
  try {
    await cli(args, password)
  } catch (error) {
    const failed = error as { code: number; stderr: string }
    return { code: failed.code, stderr: failed.stderr }
  }
  throw new Error('expected the tool to fail')
}

beforeAll(async () => {
  vi.stubGlobal('localStorage', memoryStorage())
  const created = await createKeysVault({ ...FOUNDER, displayName: 'CLI Household', currency: 'USD' })
  await writeVault(created.record, { expectedStamp: null })
  commitSealed(created.vault, created.record)
  confirmKeysSession(created.vault)
  const [group] = listGroups(created.vault)
  const invite = await createInvite(created.vault, { email: MEMBER.email, roleName: 'Manager', groupId: group.id, validity: '24h' })
  let record = await sealVault(created.vault)
  await writeVault(record, { expectedStamp: created.record.updatedAt })
  created.vault.db.close()
  const member = await redeemGrant((await readVault())!.record, { kind: 'INVITE', email: MEMBER.email, code: invite.code, password: MEMBER.password })
  const redeemed = await sealVault(member)
  await writeVault(redeemed, { expectedStamp: record.updatedAt })
  member.db.close()
  // The founder's save folds the redeemed invite into roster version 3, with its proof.
  const founder = await unlockVault((await readVault())!.record, FOUNDER.email, FOUNDER.password)
  record = await sealVault(founder, { full: true })
  await writeVault(record, { expectedStamp: redeemed.updatedAt })
  founder.db.close()
  fingerprint = created.vault.keys!.founder.fingerprint
  file = join(work, 'household.moliya')
  writeFileSync(file, backupFileText((await readVault())!.record))
})

afterAll(() => {
  vi.unstubAllGlobals()
  rmSync(work, { recursive: true, force: true })
})

describe('moliya-decrypt on a backup with per-person keys (format 3)', () => {
  it('lists who can unlock it and the founder key, without a password', async () => {
    const { stdout } = await cli([file, '--list'])
    const info = JSON.parse(stdout)
    expect(info.backupFormat).toBe(3)
    expect(info.users.map((user: { email: string }) => user.email).sort()).toEqual([FOUNDER.email, MEMBER.email].sort())
    expect(info.founderKey).toBe(formatFingerprint(fingerprint))
    expect(stdout).not.toMatch(/sealed|salt"|iv"|"ct"/)
  })

  it.skipIf(!argon2Sync)('decrypts it with a member\'s password, verifies it, and refuses a wrong one', async () => {
    const out = join(work, 'household.sqlite')
    const { stdout, stderr } = await cli([file, '--email', MEMBER.email, '--out', out, '--verify'], MEMBER.password)
    expect(stdout).toContain('backup format 3')
    expect(stderr).toContain('verified')
    expect(stderr).toContain(formatFingerprint(fingerprint))
    const db = await SqlDatabase.openBytes(new Uint8Array(readFileSync(out)))
    try {
      expect(db.queryValue('SELECT COUNT(*) FROM roster_versions')).toBe(3)
      expect(db.queryValue('SELECT COUNT(*) FROM users')).toBe(2)
    } finally {
      db.close()
    }
    const wrong = await failure([file, '--email', MEMBER.email, '--out', join(work, 'wrong.sqlite')], 'not-the-member-password')
    expect(wrong.stderr).toBe('moliya-decrypt: wrong email or password, or the backup is damaged\n')
  })

  it.skipIf(!argon2Sync)('reports a signed detail that was changed, with exit status 3', async () => {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    json.updatedAt = '2020-01-01T00:00:00.000Z'
    const tampered = join(work, 'tampered.moliya')
    writeFileSync(tampered, JSON.stringify(json))
    const result = await failure([tampered, '--email', FOUNDER.email, '--out', join(work, 'tampered.sqlite'), '--verify'], FOUNDER.password)
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('verification failed: the backup is not signed by a member of its roster')
  })

  it.skipIf(!argon2Sync)('refuses a body whose sealed list of chunks was changed, before writing anything', async () => {
    const json = JSON.parse(readFileSync(file, 'utf8'))
    // Another IV for the first chunk: the seal no longer covers the list, whatever the ciphertext.
    json.body.chunks[0] = Buffer.alloc(12, 5).toString('base64')
    const changed = join(work, 'changed.moliya')
    writeFileSync(changed, JSON.stringify(json))
    const result = await failure([changed, '--email', FOUNDER.email, '--out', join(work, 'changed.sqlite')], FOUNDER.password)
    expect(result.stderr).toBe('moliya-decrypt: wrong email or password, or the backup is damaged\n')
  })

  it.skipIf(!argon2Sync)('verifies the golden v5 backup, through a new household key and a removal', async () => {
    const fixture = fixtureByPath('v5/roster-household')
    const golden = resolve(FIXTURE_ROOT, 'v5/roster-household.moliya')
    const [, manager] = fixture.expected.users
    const { stderr } = await cli([golden, '--email', manager.email, '--out', join(work, 'golden.sqlite'), '--verify'], manager.password)
    expect(stderr).toContain(`verified (founder key ${fixture.expected.keys!.founder.fingerprint})`)
    const [removed] = fixture.expected.keys!.removed
    const gone = await failure([golden, '--email', removed.email, '--out', join(work, 'removed.sqlite')], removed.password)
    expect(gone.stderr).toBe(`moliya-decrypt: no user ${removed.email} in this backup\n`)
  })

  it.skipIf(Boolean(argon2Sync))('says which Node.js it needs where Argon2id is missing', async () => {
    const result = await failure([file, '--email', FOUNDER.email, '--out', join(work, 'old-node.sqlite')], FOUNDER.password)
    expect(result.stderr).toContain('Node.js 24.7 or newer')
  })
})
