import { ValidationError } from '../../domain/errors'
import type { Locale } from '../../i18n'
import { isIsoDate } from '../../lib/dates'
import { assertExportPassword } from './password'

export const EXPORT_FORMATS = ['csv', 'json', 'jsonl', 'xlsx', 'pdf', 'sqlite'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const PROTECTIONS = ['zip', 'sqlcipher', 'none'] as const
export type Protection = (typeof PROTECTIONS)[number]

export const PDF_ROW_LIMIT = 10_000

export type ExportRequest = {
  formats: ExportFormat[]
  period: { from: string; to: string } | null
  groupId: number | null
  includeAudit: boolean
  includeReceipts: boolean
  protection: Protection
  password?: string
  passwordConfirm?: string
  plainConfirmed?: boolean
  locale: Locale
}

export type ExportStage = 'collecting' | 'building' | 'encrypting' | 'done'

export type ExportProgress = { stage: ExportStage; format?: ExportFormat }

export type ExportResult = { blob: Blob; fileName: string; mime: string }

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value)
}

export function normalizeRequest(request: ExportRequest): ExportRequest {
  const unique = EXPORT_FORMATS.filter((format) => request.formats.includes(format))
  const formats: ExportFormat[] = request.protection === 'sqlcipher' ? ['sqlite'] : unique
  let period = request.period
  if (period) {
    if (!isIsoDate(period.from) || !isIsoDate(period.to)) throw new ValidationError('DATE')
    if (period.from > period.to) period = { from: period.to, to: period.from }
  }
  return { ...request, formats, period }
}

export function validateRequest(request: ExportRequest): ExportRequest {
  if (!PROTECTIONS.includes(request.protection)) throw new ValidationError('EXPORT_PROTECTION')
  const normalized = normalizeRequest(request)
  if (normalized.formats.length === 0) throw new ValidationError('EXPORT_NO_FORMAT')
  if (normalized.protection === 'none') {
    if (!normalized.plainConfirmed) throw new ValidationError('EXPORT_PLAIN_UNCONFIRMED')
  } else {
    assertExportPassword(normalized.password ?? '', normalized.passwordConfirm, normalized.protection)
  }
  return normalized
}

export function vaultSlug(name: string): string {
  const slug = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\p{Cc}\s]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const clipped = Array.from(slug).slice(0, 48).join('').replace(/[-.]+$/g, '')
  return clipped || 'vault'
}

export function exportFileName(vaultName: string, date: string, suffix: string): string {
  return `jaybi-${vaultSlug(vaultName)}-${date}${suffix}`
}

export const MIME: Record<string, string> = {
  csv: 'text/csv;charset=utf-8',
  json: 'application/json',
  jsonl: 'application/jsonl',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  sqlite: 'application/vnd.sqlite3',
  zip: 'application/zip',
  txt: 'text/plain;charset=utf-8',
}
