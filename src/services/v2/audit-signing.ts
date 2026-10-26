import { auditSigBody, signAuditEntry, type AuditSig } from '../../crypto/audit-sign'
import { auditRowOf, type AuditRow } from '../../db/audit-chain'
import type { SqlDatabase } from '../../db/sqlite'
import type { OpenVault } from '../../domain/types'
import type { KeysSession } from './session'

/**
 * Signing audit entries (docs/design/v2.0-key-redesign.md, 3.7). Entries are written inside synchronous transactions
 * and Web Crypto signs asynchronously, so a save signs every entry its session wrote since the last save, just before
 * it copies the image: nothing unsigned is ever stored. Each entry names the roster version and epoch of the record
 * that save stores.
 */

/** Entries from `from` on with no signature yet, in order. */
function unsignedFrom(db: SqlDatabase, from: number): AuditRow[] {
  return db
    .query(
      `SELECT a.seq, a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, a.prev_hash, a.hash
       FROM audit_logs a LEFT JOIN audit_sigs s ON s.seq = a.seq
       WHERE a.seq >= ? AND s.seq IS NULL ORDER BY a.seq`,
      [from],
    )
    .map(auditRowOf)
}

export type AuditSigning = { sigs: AuditSig[]; hashes: string[] }

/**
 * Signs what this session wrote and has not signed yet. The first entry signed in a vault is the bridge. The result is
 * stored by {@link storeAuditSigning} only if {@link auditSigningCurrent} still holds.
 */
export async function signAuditEntries(vault: OpenVault & { keys: KeysSession }, naming: { rosterVersion: number; epoch: number }): Promise<AuditSigning> {
  const { db, keys } = vault
  const rows = unsignedFrom(db, keys.auditFrom)
  const bridge = rows.length > 0 && db.queryValue('SELECT 1 FROM audit_sigs LIMIT 1') == null ? rows[0].seq : null
  const signer = { actor: keys.memberId, rosterVersion: naming.rosterVersion, epoch: naming.epoch }
  const sigs = await Promise.all(
    rows.map(async (row): Promise<AuditSig> => ({ seq: row.seq, ...signer, sig: await signAuditEntry(auditSigBody(keys.vaultId, row, signer, row.seq === bridge), keys.identity.sigPriv) })),
  )
  return { sigs, hashes: rows.map((row) => row.hash) }
}

/** Whether `signing` covers exactly the entries still unsigned: false once the session wrote more meanwhile. */
export function auditSigningCurrent(vault: OpenVault & { keys: KeysSession }, signing: AuditSigning): boolean {
  const rows = unsignedFrom(vault.db, vault.keys.auditFrom)
  return rows.length === signing.sigs.length && rows.every((row, index) => row.seq === signing.sigs[index].seq && row.hash === signing.hashes[index])
}

export function storeAuditSigning(db: SqlDatabase, signing: AuditSigning): void {
  if (signing.sigs.length === 0) return
  db.withTransaction(() => {
    for (const sig of signing.sigs) {
      db.exec('INSERT INTO audit_sigs (seq, actor, roster_version, epoch, sig) VALUES (?, ?, ?, ?, ?)', [sig.seq, sig.actor, sig.rosterVersion, sig.epoch, sig.sig])
    }
  })
}
