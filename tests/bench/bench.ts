import { argon2idBits } from '../../src/crypto/argon2'
import { CURRENT_KDF, derivePbkdf2Bits, generateDek, randomBytes } from '../../src/crypto/crypto.service'
import { unwrapDekWith, wrapDekTo } from '../../src/crypto/ecies'
import { generateIdentitySecret, importIdentity, sealIdentity, unsealIdentity, wipeSecret, type IdentityKeys } from '../../src/crypto/identity'
import { ARGON2_DEFAULT } from '../../src/crypto/kdf'
import { rosterHash, signBinding, signRoster, verifyRosterChain, type RosterDoc, type RosterMember } from '../../src/crypto/roster'
import { exportPub } from '../../src/crypto/sign'
import { SUITE } from '../../src/crypto/suite'
import { openChunkedBody, sealChunkedBody } from '../../src/db/chunks'
import { SqlDatabase } from '../../src/db/sqlite'

/**
 * The bench page of docs/design/v2.0-key-redesign.md, section 7: the per-person-keys operations, timed on the device
 * that opens the page. Served by the dev server only (`npm run bench`); nothing here is in a build.
 */

type Result = { name: string; ms: number[]; notes?: string }

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const MIB = 1024 * 1024
const PASSWORD = 'bench password for timing only'

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const ms = (value: number) => (value >= 100 ? `${value.toFixed(0)} ms` : value >= 1 ? `${value.toFixed(1)} ms` : `${value.toFixed(3)} ms`)

async function timed<T>(task: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now()
  const value = await task()
  return { ms: performance.now() - start, value }
}

async function runs(count: number, task: () => Promise<unknown>): Promise<number[]> {
  const out: number[] = []
  for (let index = 0; index < count; index += 1) out.push((await timed(task)).ms)
  return out
}

/** Fast operations are timed in batches and reported per operation. */
async function perOperation(count: number, batch: number, task: () => Promise<unknown>): Promise<number[]> {
  return (await runs(count, async () => {
    for (let index = 0; index < batch; index += 1) await task()
  })).map((total) => total / batch)
}

async function sampleDatabase(mib: number): Promise<SqlDatabase> {
  const db = await SqlDatabase.openEmpty()
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, data BLOB NOT NULL)')
  const rows = Math.ceil((mib * MIB) / 1028)
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO t (data) SELECT randomblob(1000) FROM n`)
  return db
}

async function identity(): Promise<IdentityKeys> {
  const secret = await generateIdentitySecret()
  try {
    return await importIdentity(secret)
  } finally {
    wipeSecret(secret)
  }
}

/**
 * A roster of `versions` versions: the founder alone, then `members` invited, then all of them active through key
 * bindings, then one role change per version. Verifying it checks every roster signature and two per binding.
 */
async function rosterChain(versions: number, members: number): Promise<RosterDoc[]> {
  const vaultId = crypto.randomUUID()
  const founder = await identity()
  const founderId = crypto.randomUUID()
  const at = new Date().toISOString()
  const people = await Promise.all(
    Array.from({ length: members }, async (_, index) => {
      const invite = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
      return { id: crypto.randomUUID(), email: `member${index}@bench.test`, invite, inviteSigPub: await exportPub(invite.publicKey), keys: await identity() }
    }),
  )
  const founderEntry: RosterMember = { id: founderId, email: 'founder@bench.test', role: 'Admin', group: null, status: 'active', encPub: founder.encPub, sigPub: founder.sigPub }
  const docs: RosterDoc[] = []
  const sign = async (members: RosterMember[]) => {
    const previous = docs.at(-1)
    const doc = await signRoster(
      { type: 'roster', suite: SUITE, vaultId, version: docs.length + 1, prev: previous ? await rosterHash(previous) : null, epoch: 1, issuedAt: at, issuedBy: founderId, members },
      founder.sigPriv,
    )
    docs.push(doc)
  }
  await sign([founderEntry])
  const expires = new Date(Date.now() + 86_400_000).toISOString()
  await sign([founderEntry, ...people.map((person): RosterMember => ({ id: person.id, email: person.email, role: 'Viewer', group: 1, status: 'invited', inviteSigPub: person.inviteSigPub, inviteExpiresAt: expires }))])
  const active: RosterMember[] = [founderEntry]
  for (const person of people) {
    const binding = await signBinding(
      { type: 'binding', suite: SUITE, vaultId, memberId: person.id, rosterVersion: 2, inviteSigPub: person.inviteSigPub, encPub: person.keys.encPub, sigPub: person.keys.sigPub, at },
      person.invite.privateKey,
      person.keys.sigPriv,
    )
    active.push({
      id: person.id,
      email: person.email,
      role: 'Viewer',
      group: 1,
      status: 'active',
      encPub: person.keys.encPub,
      sigPub: person.keys.sigPub,
      proof: { rosterVersion: 2, at, inviteSig: binding.inviteSig, memberSig: binding.memberSig },
    })
  }
  await sign(active)
  // Members already active carry no proof in later versions.
  let current: RosterMember[] = active.map((member) => {
    if (member.status !== 'active') return member
    const { proof: _proof, ...rest } = member
    return rest
  })
  while (docs.length < versions) {
    const index = 1 + (docs.length % members)
    current = current.map((member, position): RosterMember => (position === index ? { ...member, role: member.role === 'Viewer' ? 'Manager' : 'Viewer' } : member))
    await sign(current)
  }
  return docs
}

async function bench(settings: { mib: number; count: number; members: number }, report: (result: Result) => void, say: (text: string) => void): Promise<void> {
  say('Argon2id: starting the Worker…')
  const salt = randomBytes(16)
  const cold = await timed(() => argon2idBits(PASSWORD, salt, ARGON2_DEFAULT))
  cold.value.fill(0)
  report({ name: 'Argon2id m=64 MiB, t=3, p=1, first run', ms: [cold.ms], notes: 'Includes starting the Worker and compiling the WASM' })
  say('Argon2id…')
  report({
    name: 'Argon2id m=64 MiB, t=3, p=1',
    ms: await runs(settings.count, async () => (await argon2idBits(PASSWORD, salt, ARGON2_DEFAULT)).fill(0)),
    notes: 'The dominant cost of a sign-in, an invite and a password change',
  })
  say('PBKDF2…')
  report({ name: `PBKDF2-SHA256 ${CURRENT_KDF.iterations.toLocaleString('en')} (1.x read path)`, ms: await runs(settings.count, async () => (await derivePbkdf2Bits(PASSWORD, salt, CURRENT_KDF)).fill(0)) })

  say('Identity keys…')
  const secret = await generateIdentitySecret()
  const vaultId = crypto.randomUUID()
  const memberId = crypto.randomUUID()
  const blob = await sealIdentity(secret, { vaultId, memberId, email: 'bench@bench.test', password: PASSWORD })
  wipeSecret(secret)
  report({ name: 'Open a sealed identity (sign-in)', ms: await runs(settings.count, () => unsealIdentity(blob, vaultId, PASSWORD)), notes: 'Argon2id, AES-GCM, key import and the pairing check' })
  const keys = await unsealIdentity(blob, vaultId, PASSWORD)
  report({ name: 'X25519 key generation', ms: await perOperation(settings.count, 50, () => crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) })
  report({ name: 'Ed25519 key generation', ms: await perOperation(settings.count, 50, () => crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) })
  const peer = (await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair
  report({ name: 'X25519 agreement', ms: await perOperation(settings.count, 100, () => crypto.subtle.deriveBits({ name: 'X25519', public: peer.publicKey }, keys.encPriv, 256)) })
  const message = randomBytes(256) as Uint8Array<ArrayBuffer>
  const verifier = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const verifierSignature = await crypto.subtle.sign({ name: 'Ed25519' }, verifier.privateKey, message)
  report({ name: 'Ed25519 sign', ms: await perOperation(settings.count, 100, () => crypto.subtle.sign({ name: 'Ed25519' }, keys.sigPriv, message)) })
  report({ name: 'Ed25519 verify', ms: await perOperation(settings.count, 100, () => crypto.subtle.verify({ name: 'Ed25519' }, verifier.publicKey, verifierSignature, message)) })

  say('DEK wraps…')
  const dek = await generateDek()
  const context = { vaultId, epoch: 1, memberId }
  report({ name: 'ECIES DEK wrap to one member', ms: await perOperation(settings.count, 20, () => wrapDekTo(dek, keys.encPub, context)), notes: 'A fresh ephemeral key each time' })
  const wrap = await wrapDekTo(dek, keys.encPub, context)
  report({ name: 'ECIES DEK unwrap', ms: await perOperation(settings.count, 20, () => unwrapDekWith(wrap, keys, context)) })

  say(`Roster: ${settings.members} members, 50 versions…`)
  const docs = await rosterChain(50, settings.members)
  report({
    name: `Verify a roster chain (50 versions, ${settings.members} members)`,
    ms: await runs(settings.count, async () => {
      const chain = await verifyRosterChain(docs, docs[0].vaultId)
      if ('problem' in chain) throw new Error(`Bench roster does not verify: ${chain.problem}`)
    }),
    notes: `${50 + 2 * settings.members} signatures`,
  })

  say(`Body: building a ${settings.mib} MiB database…`)
  const db = await sampleDatabase(settings.mib)
  try {
    const size = db.sizeBytes()
    const body = { vaultId, epoch: 1 }
    const fullRuns: number[] = []
    let sealed = await sealChunkedBody(db, dek, body, null, { full: true })
    for (let index = 0; index < settings.count; index += 1) {
      const run = await timed(() => sealChunkedBody(db, dek, body, null, { full: true }))
      fullRuns.push(run.ms)
      sealed = run.value
    }
    report({ name: `Seal the whole body (${(size / MIB).toFixed(1)} MiB, ${sealed.body.chunks.length} chunks)`, ms: fullRuns, notes: 'A restore, a backup after a failed save, and the re-encryption of a rotation' })
    const openRuns: number[] = []
    let state = sealed.state
    for (let index = 0; index < settings.count; index += 1) {
      const run = await timed(() => openChunkedBody(sealed.body, dek, body))
      openRuns.push(run.ms)
      state = run.value.state
      run.value.db.close()
    }
    report({ name: 'Open the body (sign-in)', ms: openRuns, notes: 'Seal check, then each chunk decrypted into the SQLite heap' })
    const saveRuns: number[] = []
    let written = 0
    for (let index = 0; index < settings.count; index += 1) {
      db.exec('UPDATE t SET data = randomblob(1000) WHERE id = ?', [7 + index])
      const run = await timed(() => sealChunkedBody(db, dek, body, state))
      saveRuns.push(run.ms)
      state = run.value.state
      written = run.value.body.chunks.filter((chunk) => chunk.ciphertext !== undefined).length
    }
    report({ name: 'Save after an ordinary edit', ms: saveRuns, notes: `Copy and hash the image, encrypt ${written} changed chunk(s)` })

    say('Rotation estimate…')
    const recipients = await Promise.all(Array.from({ length: settings.members }, () => identity()))
    const rotationRuns = await runs(settings.count, async () => {
      const next = await generateDek()
      await sealChunkedBody(db, next, { vaultId, epoch: 2 }, null, { full: true })
      for (const recipient of recipients) await wrapDekTo(next, recipient.encPub, { vaultId, epoch: 2, memberId })
    })
    report({ name: `Rotation: re-encrypt the body and wrap to ${settings.members} members`, ms: rotationRuns, notes: 'Without signing and storing' })
  } finally {
    db.close()
  }
}

function start(): void {
  const button = element<HTMLButtonElement>('start')
  const rows = element<HTMLTableSectionElement>('results')
  const status = element<HTMLParagraphElement>('status')
  const output = element<HTMLTextAreaElement>('report')
  button.addEventListener('click', () => {
    const settings = {
      mib: Math.min(512, Math.max(1, Number(element<HTMLInputElement>('size').value) || 20)),
      count: Math.min(20, Math.max(1, Number(element<HTMLInputElement>('runs').value) || 3)),
      members: Math.min(256, Math.max(1, Number(element<HTMLInputElement>('members').value) || 20)),
    }
    const results: Result[] = []
    rows.replaceChildren()
    output.value = ''
    button.disabled = true
    const report = (result: Result) => {
      results.push(result)
      const row = document.createElement('tr')
      const cells = [result.name, ms(median(result.ms)), ms(Math.min(...result.ms)), ms(Math.max(...result.ms)), result.notes ?? '']
      cells.forEach((text, index) => {
        const cell = document.createElement('td')
        cell.textContent = text
        if (index >= 1 && index <= 3) cell.className = 'n'
        row.append(cell)
      })
      rows.append(row)
    }
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
    void bench(settings, report, (text) => (status.textContent = text))
      .then(
        () => (status.textContent = 'Done.'),
        (error: unknown) => (status.textContent = `Stopped: ${error instanceof Error ? error.message : String(error)}`),
      )
      .finally(() => {
        button.disabled = false
        output.value = JSON.stringify(
          {
            bench: 'jaybi-v2',
            at: new Date().toISOString(),
            userAgent: navigator.userAgent,
            cores: navigator.hardwareConcurrency,
            deviceMemoryGiB: memory ?? null,
            crossOriginIsolated: globalThis.crossOriginIsolated,
            settings,
            results: results.map((result) => ({ name: result.name, medianMs: Number(median(result.ms).toFixed(3)), minMs: Number(Math.min(...result.ms).toFixed(3)), maxMs: Number(Math.max(...result.ms).toFixed(3)), notes: result.notes })),
          },
          null,
          2,
        )
      })
  })
}

start()
