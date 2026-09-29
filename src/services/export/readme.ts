import type { ExportMeta } from './dataset'
import type { Protection } from './options'

const DESCRIPTIONS: Record<string, string> = {
  'transactions.csv': 'Records as CSV (RFC 4180, UTF-8 with BOM, comma separator, dot decimals).',
  'audit-log.csv': 'Audit log as CSV. Use moliya.json to verify the hash chain exactly.',
  'moliya.json': 'Everything in one JSON document ("moliya-export" format version 1).',
  'moliya.jsonl': 'The same data as JSON Lines: header, one record per line, footer with counts.',
  'moliya.xlsx': 'Excel workbook with typed numbers and dates.',
  'report.pdf': 'Printable financial report.',
  'moliya.sqlite': 'SQLite 3 database with the same tables as the vault (passwords removed).',
}

export function buildReadme(meta: ExportMeta, files: string[], protection: Protection): string {
  const lines = [
    'Moliya data export',
    '==================',
    '',
    `Vault: ${meta.vault.name}`,
    `Exported: ${meta.exportedAt} by ${meta.exportedBy.email}`,
    `App: ${meta.app.name} ${meta.app.version} (${meta.app.commit}), schema version ${meta.schemaVersion}`,
    `Period: ${meta.scope.from && meta.scope.to ? `${meta.scope.from} to ${meta.scope.to}` : 'all data'}`,
    `Group: ${meta.scope.groupName ?? 'all groups'}`,
    `Audit log included: ${meta.scope.includesAudit ? 'yes' : 'no'}`,
    `Receipt images included: ${meta.scope.includesReceipts ? 'yes' : 'no'}`,
    '',
    'Files',
    '-----',
    ...files.map((file) => `${file}: ${DESCRIPTIONS[file] ?? ''}`.trimEnd()),
    '',
    'Notes',
    '-----',
    'Amounts are exact: amount_minor / amountMinor is an integer in the currency\'s minor unit (cents, tiyin).',
    'Exports are one-way copies for other apps. To move or restore a vault, use a .moliya backup.',
    'Format description: https://github.com/kool277/iqtisod/blob/main/docs/data-format.md#exports',
  ]
  if (protection === 'zip') {
    lines.push(
      '',
      'This archive is encrypted with AES-256 (WinZip AE-2). Open it with 7-Zip, WinZip, WinRAR, or Keka.',
      'The built-in Windows and macOS archive tools cannot open AES-encrypted archives.',
      'File names inside the archive are visible without the password; their contents are not.',
    )
  } else {
    lines.push('', 'This archive is NOT encrypted. Anyone who gets it can read every record.')
  }
  return `${lines.join('\r\n')}\r\n`
}
