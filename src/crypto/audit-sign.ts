import type { AuditRow } from '../db/audit-chain'
import { LABELS, signPayload, verifyPayload } from './sign'
import { SUITE, type Suite } from './suite'

/**
 * Signed audit entries (docs/design/v2.0-key-redesign.md, 3.7). The entry stays the 1.x row with its chain hash; its
 * signature lives beside it in `audit_sigs` and covers that hash, which covers every column, so 1.x rows and their
 * hashes are unchanged. The first signed entry of a vault carries `bridge`, so cutting signatures off the start of the
 * signed part of the log breaks the signature of the entry that would become the first.
 */

/** A row of `audit_sigs`. `actor` is the signer, who must be the entry's actor unless the entry has none. */
export type AuditSig = { seq: number; actor: string; rosterVersion: number; epoch: number; sig: string }

export type AuditSigBody = {
  type: 'audit'
  suite: Suite
  vaultId: string
  seq: number
  /** The chain hash of the entry before (64 zeros for the first). */
  prev: string
  /** The entry's own chain hash. */
  hash: string
  /** The roster version of the record that first stores the entry, and its epoch. */
  rosterVersion: number
  epoch: number
  at: string
  actor: string
  action: string
  bridge?: true
}

export function auditSigBody(vaultId: string, row: AuditRow, signer: Omit<AuditSig, 'seq' | 'sig'>, bridge: boolean): AuditSigBody {
  return {
    type: 'audit',
    suite: SUITE,
    vaultId,
    seq: row.seq,
    prev: row.prevHash,
    hash: row.hash,
    rosterVersion: signer.rosterVersion,
    epoch: signer.epoch,
    at: row.createdAt,
    actor: signer.actor,
    action: row.action,
    ...(bridge ? { bridge: true as const } : {}),
  }
}

export function signAuditEntry(body: AuditSigBody, sigPriv: CryptoKey): Promise<string> {
  return signPayload(LABELS.audit, body, sigPriv)
}

/** False for any mismatch or malformed input; never throws. */
export function verifyAuditEntry(body: AuditSigBody, signature: unknown, sigPub: unknown): Promise<boolean> {
  return verifyPayload(LABELS.audit, body, signature, sigPub)
}
