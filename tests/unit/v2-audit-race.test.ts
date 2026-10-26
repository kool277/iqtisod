import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeysRecord } from '../../src/db/envelope'
import { readVault, writeVault } from '../../src/db/storage'
import { KEYS_RECORD_VERSION } from '../../src/db/versions'
import type { OpenVault } from '../../src/domain/types'
import { sealVault, unlockVault } from '../../src/services/auth.service'
import { createInvite } from '../../src/services/grant.service'
import { listGroups } from '../../src/services/group.service'
import { checkVaultAudit } from '../../src/services/v2/audit-check'
import { commitSealed, confirmKeysSession, rotationOf, type KeysSession } from '../../src/services/v2/session'
import { createKeysVault } from '../../src/services/v2/vault'
import { memoryStorage } from '../support/memory-storage'

vi.mock('../../src/crypto/kdf', async (load) => {
  const actual = await load<typeof import('../../src/crypto/kdf')>()
  return { ...actual, ARGON2_DEFAULT: { name: 'Argon2id', m: 19_456, t: 2, p: 1, len: 32, v: 19 } }
})

// Holds the roster read of a check open, so a save can finish meanwhile: the window the app has while Web Crypto hashes
// the roster versions.
const gate: { wait: Promise<void> | null } = { wait: null }
vi.mock('../../src/services/v2/roster-store', async (load) => {
  const actual = await load<typeof import('../../src/services/v2/roster-store')>()
  return {
    ...actual,
    readRosterDocs: async (db: Parameters<typeof actual.readRosterDocs>[0]) => {
      const reading = actual.readRosterDocs(db)
      if (gate.wait) await gate.wait
      return reading
    },
  }
})

const FOUNDER = { email: 'founder@race.test', password: 'founder-race-password-1' }
const open: OpenVault[] = []
const track = <T extends OpenVault>(vault: T): T => (open.push(vault), vault)

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()))

afterEach(async () => {
  for (const vault of open.splice(0)) {
    try {
      vault.db.close()
    } catch {
      // Already closed.
    }
  }
  vi.unstubAllGlobals()
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('moliya')
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
  })
})

async function stored(): Promise<KeysRecord> {
  const loaded = await readVault()
  if (!loaded || loaded.record.version !== KEYS_RECORD_VERSION) throw new Error('no version 3 record stored')
  return loaded.record
}

describe('a signature check that a save overtakes', () => {
  it('counts the entries the save signs meanwhile as pending, not as unsigned', async () => {
    const created = await createKeysVault({ ...FOUNDER, displayName: 'Race', currency: 'USD' })
    track(created.vault)
    await writeVault(created.record, { expectedStamp: null })
    commitSealed(created.vault, created.record)
    confirmKeysSession(created.vault)
    const founder = track(await unlockVault(await stored(), FOUNDER.email, FOUNDER.password)) as OpenVault & { keys: KeysSession }
    confirmKeysSession(founder)
    const [group] = listGroups(founder)
    await createInvite(founder, { email: 'x@race.test', roleName: 'Viewer', groupId: group.id, validity: '24h' })
    let release!: () => void
    gate.wait = new Promise<void>((resolve) => (release = resolve))
    const checking = checkVaultAudit(founder, { full: true })
    // The save signs the pending entry and moves the session's mark on while the check reads the roster.
    const record = await sealVault(founder)
    await writeVault(record, { expectedStamp: created.record.updatedAt, rotation: rotationOf(founder, record) })
    commitSealed(founder, record)
    release()
    gate.wait = null
    expect((await checking)!.problems.size).toBe(0)
    expect((await checkVaultAudit(founder, { full: true }))!.problems.size).toBe(0)
  })
})
