import type { ReactNode } from 'react'
import type { ViewCell, ViewKind } from '../../services/export/view-cells'
import type { ColumnModel, FilterOption } from './model'

export type EditInput = 'text' | 'decimal' | 'date' | 'select'

/** Inline editing goes through the page's existing service call, so validation, RBAC and audit stay where they are. */
export type EditSpec<T> = {
  input: EditInput
  value: (row: T) => string
  options?: (row: T) => FilterOption[]
  enabled?: (row: T) => boolean
  maxLength?: number
  save: (row: T, value: string) => Promise<void>
}

export type Column<T> = ColumnModel<T> & {
  header: string
  cell: (row: T) => ReactNode
  /** How the column appears in an exported file; columns without it are never exported. */
  exportAs?: { kind: ViewKind; value: (row: T) => ViewCell }
  /** `false` keeps the column visible at all times. */
  hideable?: boolean
  /** Hidden until the reader turns it on. */
  hidden?: boolean
  align?: 'end'
  className?: string
  edit?: EditSpec<T>
}
