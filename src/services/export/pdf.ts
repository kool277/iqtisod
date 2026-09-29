import { jsPDF } from 'jspdf'
import { autoTable, type RowInput, type UserOptions } from 'jspdf-autotable'
import { htmlLang, translate, type Locale, type MessageKey } from '../../i18n'
import { formatIsoDate, formatMoney, formatWhen, intlLocale } from '../../lib/money'
import type { CategoryNames, CurrencyTotals, ExportDataset } from './dataset'
import { PDF_ROW_LIMIT } from './options'
import type { PdfFonts } from './pdf-fonts'

const FONT = 'NotoSans'
const MARGIN = 40
const NOTES_LIMIT = 120
const HEAD_FILL: [number, number, number] = [22, 101, 52]
const MUTED: [number, number, number] = [100, 100, 100]

export type PdfOptions = { locale: Locale; fonts: PdfFonts; rowLimit?: number; signal?: AbortSignal }

function categoryName(names: CategoryNames, locale: Locale): string {
  return names[locale] || names.en
}

function clip(text: string | null, limit: number): string {
  if (!text) return ''
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : chars.join('')
}

function finalY(doc: jsPDF): number {
  return (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY
}

export async function buildPdf(dataset: ExportDataset, options: PdfOptions): Promise<Blob> {
  const { locale } = options
  const t = (key: MessageKey) => translate(locale, key)
  const money = (minor: number | bigint, currency: string) => formatMoney(Number(minor), currency, locale)
  const percent = new Intl.NumberFormat(intlLocale(locale), { style: 'percent', maximumFractionDigits: 1 })
  const count = new Intl.NumberFormat(intlLocale(locale))
  const { meta, summary } = dataset
  const limit = options.rowLimit ?? PDF_ROW_LIMIT

  const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: true })
  doc.addFileToVFS('NotoSans-Regular.ttf', options.fonts.regular)
  doc.addFont('NotoSans-Regular.ttf', FONT, 'normal')
  doc.addFileToVFS('NotoSans-Bold.ttf', options.fonts.bold)
  doc.addFont('NotoSans-Bold.ttf', FONT, 'bold')
  const lang = htmlLang(locale)
  const internal = doc.internal as typeof doc.internal & { write: (text: string) => void }
  internal.events.subscribe('putCatalog', () => internal.write(`/Lang (${lang})`))
  doc.setProperties({ title: `${meta.vault.name} — ${t('export.pdf.title')}`, creator: 'Moliya' })

  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const tableDefaults: Partial<UserOptions> = {
    margin: { left: MARGIN, right: MARGIN, bottom: MARGIN + 10 },
    styles: { font: FONT, fontSize: 8.5, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { font: FONT, fontStyle: 'bold', fillColor: HEAD_FILL, textColor: 255 },
    alternateRowStyles: { fillColor: [245, 247, 245] },
  }

  let y = MARGIN + 8
  doc.setFont(FONT, 'bold')
  doc.setFontSize(18)
  doc.text(meta.vault.name, MARGIN, y)
  y += 20
  doc.setFont(FONT, 'normal')
  doc.setFontSize(12)
  doc.text(t('export.pdf.title'), MARGIN, y)
  y += 16
  doc.setFontSize(9)
  doc.setTextColor(...MUTED)
  const period =
    meta.scope.from && meta.scope.to
      ? `${formatIsoDate(meta.scope.from, locale)} – ${formatIsoDate(meta.scope.to, locale)}`
      : t('export.pdf.allTime')
  const lines = [
    `${t('export.period')}: ${period}`,
    `${t('export.group')}: ${meta.scope.groupName ?? t('export.allGroups')}`,
    `${t('export.pdf.generated')}: ${formatWhen(meta.exportedAt, locale)} · ${meta.exportedBy.email}`,
    `${meta.app.name} ${meta.app.version}`,
  ]
  for (const line of lines) {
    doc.text(line, MARGIN, y)
    y += 12
  }
  doc.setTextColor(0)

  const heading = (text: string) => {
    if (y > pageHeight - MARGIN * 3) {
      doc.addPage()
      y = MARGIN
    }
    y += 14
    doc.setFont(FONT, 'bold')
    doc.setFontSize(12)
    doc.text(text, MARGIN, y)
    doc.setFont(FONT, 'normal')
    y += 6
  }

  const kpiRows = (totals: CurrencyTotals[]): RowInput[] =>
    totals.map((total) => [
      total.currency,
      money(total.incomeMinor, total.currency),
      money(total.expenseMinor, total.currency),
      money(total.netMinor, total.currency),
      total.incomeMinor > 0n ? percent.format(Number(total.netMinor) / Number(total.incomeMinor)) : '—',
    ])
  const kpiHead = [[t('common.currency'), t('kpi.income'), t('kpi.expense'), t('kpi.net'), t('kpi.savings')]]
  const right = { halign: 'right' as const }
  const kpiColumns = { 1: right, 2: right, 3: right, 4: right }
  const primary = summary.totals.filter((total) => total.currency === meta.vault.currency)
  const others = summary.totals.filter((total) => total.currency !== meta.vault.currency)

  heading(t('dashboard.title'))
  autoTable(doc, { ...tableDefaults, startY: y, head: kpiHead, body: kpiRows(primary.length ? primary : others), columnStyles: kpiColumns })
  y = finalY(doc) + 6
  if (primary.length && others.length) {
    heading(t('export.pdf.otherCurrencies'))
    autoTable(doc, { ...tableDefaults, startY: y, head: kpiHead, body: kpiRows(others), columnStyles: kpiColumns })
    y = finalY(doc) + 6
  }

  if (summary.byCategory.length) {
    const categories = new Map(dataset.categories.map((category) => [category.id, category]))
    heading(t('export.pdf.byCategory'))
    autoTable(doc, {
      ...tableDefaults,
      startY: y,
      head: [[t('common.category'), t('common.currency'), t('kpi.expense')]],
      body: summary.byCategory.map((item) => {
        const category = categories.get(item.categoryId)
        return [category ? categoryName(category.names, locale) : String(item.categoryId), item.currency, money(item.expenseMinor, item.currency)]
      }),
      columnStyles: { 2: right },
    })
    y = finalY(doc) + 6
  }

  if (summary.byMonth.length) {
    heading(t('export.pdf.byMonth'))
    autoTable(doc, {
      ...tableDefaults,
      startY: y,
      head: [[t('export.pdf.month'), t('common.currency'), t('kpi.income'), t('kpi.expense'), t('kpi.net')]],
      body: summary.byMonth.map((item) => [
        item.month,
        item.currency,
        money(item.incomeMinor, item.currency),
        money(item.expenseMinor, item.currency),
        money(item.incomeMinor - item.expenseMinor, item.currency),
      ]),
      columnStyles: { 2: right, 3: right, 4: right },
    })
    y = finalY(doc) + 6
  }

  const body: RowInput[] = []
  for await (const page of dataset.transactionPages(options.signal, limit)) {
    for (const row of page) {
      body.push([
        row.date,
        row.type === 'INCOME' ? t('tx.income') : t('tx.expense'),
        categoryName(row.categoryNames, locale),
        row.groupName,
        money(row.amountMinor, row.currency),
        clip(row.notes, NOTES_LIMIT),
      ])
    }
  }
  heading(`${t('export.pdf.records')} (${count.format(dataset.counts.transactions)})`)
  if (dataset.counts.transactions > body.length) {
    doc.setFontSize(9)
    doc.setTextColor(...MUTED)
    y += 8
    const note = doc.splitTextToSize(`${t('export.pdfLimit')} ${count.format(body.length)}`, pageWidth - MARGIN * 2) as string[]
    doc.text(note, MARGIN, y)
    y += note.length * 11
    doc.setTextColor(0)
  }
  if (body.length) {
    autoTable(doc, {
      ...tableDefaults,
      startY: y,
      head: [[t('common.date'), t('common.type'), t('common.category'), t('common.group'), t('common.amount'), t('common.notes')]],
      body,
      columnStyles: { 0: { cellWidth: 58 }, 4: { halign: 'right', cellWidth: 92 }, 5: { cellWidth: 150 } },
    })
  }

  const pages = doc.getNumberOfPages()
  for (let page = 1; page <= pages; page += 1) {
    doc.setPage(page)
    doc.setFont(FONT, 'normal')
    doc.setFontSize(8)
    doc.setTextColor(...MUTED)
    doc.text(t('export.pdf.confidential'), MARGIN, pageHeight - MARGIN / 2)
    doc.text(`${t('export.pdf.page')} ${page} ${t('export.pdf.of')} ${pages}`, pageWidth - MARGIN, pageHeight - MARGIN / 2, { align: 'right' })
  }
  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' })
}
