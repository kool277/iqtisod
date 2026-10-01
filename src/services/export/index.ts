import { SqlDatabase } from '../../db/sqlite'
import { ValidationError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import { toIsoDate } from '../../lib/dates'
import { writeAudit } from '../audit.service'
import { buildAuditCsv, buildTransactionsCsv } from './csv'
import { countScope, createDataset, resolveExportScope, throwIfAborted, type ExportDataset } from './dataset'
import { buildJson, buildJsonl } from './json'
import {
  MIME,
  exportFileName,
  validateRequest,
  type ExportFormat,
  type ExportProgress,
  type ExportRequest,
  type ExportResult,
} from './options'
import { commonExportPasswordProblem, isSignInPassword } from './password'
import type { PdfFonts } from './pdf-fonts'
import { buildReadme } from './readme'
import { encryptSqlcipher4, type RandomSource } from './sqlcipher'
import { SQLCIPHER_RESERVE_BYTES, buildExportDatabase } from './sqlite'
import type { ZipEntry } from './zip'

export type ExportContext = {
  signal?: AbortSignal
  onProgress?: (progress: ExportProgress) => void
  now?: Date
  random?: RandomSource
  fonts?: PdfFonts
  app?: { name: string; version: string; commit: string }
}

type BuildContext = { dataset: ExportDataset; source: Uint8Array; request: ExportRequest; context: ExportContext }

async function buildFormat(format: ExportFormat, { dataset, source, request, context }: BuildContext): Promise<ZipEntry[]> {
  const { signal } = context
  switch (format) {
    case 'csv': {
      const entries: ZipEntry[] = [{ name: 'transactions.csv', blob: await buildTransactionsCsv(dataset, signal) }]
      if (dataset.meta.scope.includesAudit) entries.push({ name: 'audit-log.csv', blob: await buildAuditCsv(dataset, signal) })
      return entries
    }
    case 'json':
      return [{ name: 'jaybi.json', blob: await buildJson(dataset, signal) }]
    case 'jsonl':
      return [{ name: 'jaybi.jsonl', blob: await buildJsonl(dataset, signal) }]
    case 'xlsx': {
      const { buildXlsx } = await import('./xlsx')
      return [{ name: 'jaybi.xlsx', blob: await buildXlsx(dataset, request.locale, signal), stored: true }]
    }
    case 'pdf': {
      const [{ buildPdf }, fonts] = await Promise.all([
        import('./pdf'),
        context.fonts ?? import('./pdf-fonts').then((module) => module.loadPdfFonts()),
      ])
      return [{ name: 'report.pdf', blob: await buildPdf(dataset, { locale: request.locale, fonts, signal }), stored: true }]
    }
    case 'sqlite': {
      const bytes = await buildExportDatabase(source, dataset.meta, { reserveBytes: 0 })
      return [{ name: 'jaybi.sqlite', blob: new Blob([bytes as BlobPart], { type: MIME.sqlite }) }]
    }
  }
}

function extensionOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1)
}

export async function runExport(vault: OpenVault, input: ExportRequest, context: ExportContext = {}): Promise<ExportResult> {
  const { signal, onProgress } = context
  const request = validateRequest(input)
  const scope = resolveExportScope(vault.user, request, vault.db)
  throwIfAborted(signal)
  onProgress?.({ stage: 'collecting' })
  if (request.protection !== 'none') {
    const password = request.password ?? ''
    const emails = [vault.user.email, ...vault.wraps.map((wrap) => wrap.email)]
    const problem = await commonExportPasswordProblem(password, { vaultName: vault.vaultName, emails })
    if (problem) throw new ValidationError(problem)
    if (await isSignInPassword(vault, password)) throw new ValidationError('EXPORT_PASSWORD_REUSED')
  }
  throwIfAborted(signal)

  const counts = countScope(vault.db, scope)
  writeAudit(vault.db, vault.user.id, 'DATA_EXPORTED', 'vault', 'primary', {
    formats: request.formats,
    protection: request.protection,
    scope: { from: scope.from, to: scope.to, groupId: scope.groupId },
    includesAudit: scope.includesAudit,
    includesReceipts: scope.includesReceipts,
    counts,
  })

  const now = context.now ?? new Date()
  const source = vault.db.export()
  const snapshot = await SqlDatabase.openBytes(source)
  try {
    const dataset = createDataset(snapshot, scope, { user: vault.user, now, app: context.app })
    const date = toIsoDate(now)
    const name = (suffix: string) => exportFileName(dataset.meta.vault.name, date, suffix)

    if (request.protection === 'sqlcipher') {
      onProgress?.({ stage: 'building', format: 'sqlite' })
      const plain = await buildExportDatabase(source, dataset.meta, { reserveBytes: SQLCIPHER_RESERVE_BYTES })
      throwIfAborted(signal)
      onProgress?.({ stage: 'encrypting' })
      const encrypted = await encryptSqlcipher4(plain, request.password ?? '', context.random)
      plain.fill(0)
      throwIfAborted(signal)
      onProgress?.({ stage: 'done' })
      return { blob: new Blob([encrypted as BlobPart], { type: MIME.sqlite }), fileName: name('-encrypted.sqlite'), mime: MIME.sqlite }
    }

    const entries: ZipEntry[] = []
    for (const format of request.formats) {
      throwIfAborted(signal)
      onProgress?.({ stage: 'building', format })
      entries.push(...(await buildFormat(format, { dataset, source, request, context })))
    }
    throwIfAborted(signal)

    if (request.protection === 'none' && entries.length === 1) {
      const [entry] = entries
      const extension = extensionOf(entry.name)
      onProgress?.({ stage: 'done' })
      return { blob: entry.blob, fileName: name(`.${extension}`), mime: MIME[extension] ?? 'application/octet-stream' }
    }

    const readme = buildReadme(dataset.meta, entries.map((entry) => entry.name), request.protection)
    entries.push({ name: 'README.txt', blob: new Blob([readme], { type: MIME.txt }) })
    if (request.protection === 'zip') onProgress?.({ stage: 'encrypting' })
    const { buildZip } = await import('./zip')
    const blob = await buildZip(entries, { password: request.protection === 'zip' ? request.password : undefined, signal, now })
    onProgress?.({ stage: 'done' })
    return { blob, fileName: name(request.protection === 'zip' ? '-encrypted.zip' : '.zip'), mime: MIME.zip }
  } finally {
    snapshot.close()
  }
}

export type { ExportFormat, ExportProgress, ExportRequest, ExportResult, Protection } from './options'
