import { isAuditHead, type AuditHead } from '../db/audit-chain'

/** The furthest audit entry this browser has seen in the vault, kept outside it so a shortened or rewritten log shows up. */
export const AUDIT_MARK_KEY = 'moliya.auditMark.v1'

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function browserStore(): Store | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readAuditMark(storage = browserStore()): AuditHead | null {
  try {
    const value: unknown = JSON.parse(storage?.getItem(AUDIT_MARK_KEY) ?? 'null')
    return isAuditHead(value) ? { seq: value.seq, hash: value.hash } : null
  } catch {
    return null
  }
}

/** Only moves forward: a lower seq never replaces a higher one, except through {@link resetAuditMark}. */
export function advanceAuditMark(head: AuditHead, storage = browserStore()): void {
  const current = readAuditMark(storage)
  if (current && current.seq > head.seq) return
  resetAuditMark(head, storage)
}

export function resetAuditMark(head: AuditHead | null, storage = browserStore()): void {
  try {
    if (head) storage?.setItem(AUDIT_MARK_KEY, JSON.stringify({ seq: head.seq, hash: head.hash }))
    else storage?.removeItem(AUDIT_MARK_KEY)
  } catch {
    // Without storage the check falls back to the head recorded in the vault record.
  }
}
