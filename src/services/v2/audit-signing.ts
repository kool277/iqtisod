import { auditSigBody, signAuditEntry, type AuditSig } from '../../crypto/audit-sign'
import type { RosterDoc } from '../../crypto/roster'
import { auditHead, readAuditRows, type AuditHead, type AuditRow } from '../../db/audit-chain'
import type { SqlDatabase } from '../../db/sqlite'
import type { OpenVault } from '../../domain/types'
import type { KeysSession } from './session'

/**
 * Signing audit entries (docs/design/v2.0-key-redesign.md, 3.7). Entries are written inside synchronous transactions
 * and Web Crypto signs asynchronously, so a save signs every entry its session wrote since the one before, just before
 * it copies the image: nothing unsigned is ever stored. Each entry names the roster version and epoch of that save.
 */

/**
 * The entries this session wrote and has not signed: everything after the last one it signed. A signature row already
 * at one of those seqs was left behind by entries cut off the log, and is replaced.
 */
export function auditPending(vault: OpenVault & { keys: KeysSession }): AuditRow[] {
  return readAuditRows(vault.db, vault.keys.auditSigned)
}

/**
 * The entry the signed log starts at, which is signed as the bridge: the anchor of the latest roster version, or else
 * the first signed entry (once `pending` is signed); null while nothing is or will be signed.
 */
export function auditBridge(db: SqlDatabase, latest: RosterDoc, pending: readonly AuditRow[]): number | null {
  if (latest.audit) return latest.audit.from
  const first = pending[0]?.seq
  const before = db.queryValue('SELECT MIN(seq) FROM audit_sigs WHERE seq < ?', [first ?? Number.MAX_SAFE_INTEGER])
  return before != null ? Number(before) : (first ?? null)
}

export type AuditSigning = { sigs: AuditSig[]; hashes: string[]; head: AuditHead }

/**
 * Signs `pending` (from {@link auditPending}); `head` is then the last entry of the log the save stores. The result is
 * stored by {@link storeAuditSigning} only if {@link auditSigningCurrent} still holds.
 */
export async function signAuditEntries(
  vault: OpenVault & { keys: KeysSession },
  pending: readonly AuditRow[],
  naming: { rosterVersion: number; epoch: number },
  bridge: number | null,
): Promise<AuditSigning> {
  const { keys } = vault
  const last = pending.at(-1)
  const head = last ? { seq: last.seq, hash: last.hash } : auditHead(vault.db)
  const signer = { actor: keys.memberId, rosterVersion: naming.rosterVersion, epoch: naming.epoch }
  const sigs = await Promise.all(
    pending.map(async (row): Promise<AuditSig> => ({ seq: row.seq, ...signer, sig: await signAuditEntry(auditSigBody(keys.vaultId, row, signer, row.seq === bridge), keys.identity.sigPriv) })),
  )
  return { sigs, hashes: pending.map((row) => row.hash), head }
}

/** Whether `signing` covers exactly the entries still pending: false once the session wrote more meanwhile. */
export function auditSigningCurrent(vault: OpenVault & { keys: KeysSession }, signing: AuditSigning): boolean {
  const rows = auditPending(vault)
  return rows.length === signing.sigs.length && rows.every((row, index) => row.seq === signing.sigs[index].seq && row.hash === signing.hashes[index])
}

export function storeAuditSigning(vault: OpenVault & { keys: KeysSession }, signing: AuditSigning): void {
  if (signing.sigs.length === 0) return
  vault.db.withTransaction(() => {
    for (const sig of signing.sigs) {
      vault.db.exec('INSERT OR REPLACE INTO audit_sigs (seq, actor, roster_version, epoch, sig) VALUES (?, ?, ?, ?, ?)', [sig.seq, sig.actor, sig.rosterVersion, sig.epoch, sig.sig])
    }
  })
  vault.keys.auditSigned = signing.sigs[signing.sigs.length - 1].seq
}
