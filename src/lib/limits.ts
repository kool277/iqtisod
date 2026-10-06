const MIB = 1024 * 1024

export const LIMITS = {
  emailChars: 254,
  passwordMin: 12,
  passwordMax: 256,
  nameChars: 80,
  notesChars: 2000,
  receiptBytes: Math.floor(1.5 * MIB),
  /** The smallest growth budget on any device; the device's own budget is in `src/lib/capacity.ts`. */
  databaseBudgetBytes: 48 * MIB,
  databaseWarnBytes: 36 * MIB,
  /** The fixed backup file cap of 1.3.0–1.6.0. Every device still accepts files this large, and in-memory JSON parsing stops here. */
  importFileBytes: 72 * MIB,
  /** `ENGINE_MAX_BYTES` in `src/lib/capacity.ts` plus the GCM tag: no device can open a larger vault. */
  ciphertextBytes: 640 * MIB + 16,
  sqliteValueBytes: 8 * MIB,
  jsonDepth: 8,
  wraps: 256,
  grants: 64,
  openInvites: 20,
} as const

export function formatMiB(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`
}
