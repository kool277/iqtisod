const MIB = 1024 * 1024

export const LIMITS = {
  emailChars: 254,
  passwordMin: 12,
  passwordMax: 256,
  nameChars: 80,
  notesChars: 2000,
  receiptBytes: Math.floor(1.5 * MIB),
  databaseBudgetBytes: 48 * MIB,
  databaseWarnBytes: 36 * MIB,
  importFileBytes: 72 * MIB,
  ciphertextBytes: 64 * MIB,
  sqliteValueBytes: 8 * MIB,
  jsonDepth: 8,
  wraps: 256,
  grants: 64,
  openInvites: 20,
} as const

export function formatMiB(bytes: number): string {
  return `${Math.round(bytes / MIB)} MB`
}
