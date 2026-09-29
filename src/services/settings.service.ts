import { setSetting } from '../db/settings'
import type { SqlValue } from '../db/sqlite'
import { ForbiddenError, ValidationError } from '../domain/errors'
import { isCurrency, type Category, type EntryType, type OpenVault } from '../domain/types'
import { Permission, canUser } from '../rbac'
import { writeAudit } from './audit.service'

export type VaultSettingsInput = {
  vaultName: string
  currency: string
}

export type CategoryInput = {
  type: EntryType
  nameEn: string
  nameUzLatn: string
  nameUzCyrl: string
  nameRu: string
}

function assertSettings(vault: OpenVault): void {
  if (!canUser(vault.user, Permission.MANAGE_SETTINGS)) throw new ForbiddenError()
}

export function updateVaultSettings(vault: OpenVault, input: VaultSettingsInput): void {
  assertSettings(vault)
  const vaultName = input.vaultName.trim()
  if (!vaultName || vaultName.length > 80) throw new ValidationError('REQUIRED')
  if (!isCurrency(input.currency)) throw new ValidationError('CURRENCY')
  vault.db.withTransaction(() => {
    setSetting(vault.db, 'vault_name', vaultName)
    setSetting(vault.db, 'currency', input.currency)
    writeAudit(vault.db, vault.user.id, 'SETTINGS_UPDATED', 'vault', 'primary', {
      vaultName,
      currency: input.currency,
    })
  })
  vault.vaultName = vaultName
  vault.currency = input.currency
}

function cleanNames(input: CategoryInput): SqlValue[] {
  const nameEn = input.nameEn.trim()
  if (!nameEn || nameEn.length > 60) throw new ValidationError('REQUIRED')
  const fallback = (value: string) => value.trim().slice(0, 60) || nameEn
  return [nameEn, fallback(input.nameUzLatn), fallback(input.nameUzCyrl), fallback(input.nameRu)]
}

export function createCategory(vault: OpenVault, input: CategoryInput): void {
  assertSettings(vault)
  if (input.type !== 'INCOME' && input.type !== 'EXPENSE') throw new ValidationError('TYPE')
  const names = cleanNames(input)
  vault.db.withTransaction(() => {
    vault.db.exec(
      `INSERT INTO categories (name_en, name_uz_latn, name_uz_cyrl, name_ru, type, icon)
       VALUES (?, ?, ?, ?, ?, 'circle')`,
      [...names, input.type],
    )
    const id = String(vault.db.queryValue('SELECT last_insert_rowid()') ?? '')
    writeAudit(vault.db, vault.user.id, 'CATEGORY_CREATED', 'category', id, { name: names[0], type: input.type })
  })
}

export function updateCategory(vault: OpenVault, id: number, input: Omit<CategoryInput, 'type'>): void {
  assertSettings(vault)
  const existing = vault.db.queryValue('SELECT id FROM categories WHERE id = ?', [id])
  if (existing == null) throw new ValidationError('REQUIRED')
  const names = cleanNames({ ...input, type: 'EXPENSE' })
  vault.db.withTransaction(() => {
    vault.db.exec(
      'UPDATE categories SET name_en = ?, name_uz_latn = ?, name_uz_cyrl = ?, name_ru = ? WHERE id = ?',
      [...names, id],
    )
    writeAudit(vault.db, vault.user.id, 'CATEGORY_UPDATED', 'category', String(id), { name: names[0] })
  })
}

export function deleteCategory(vault: OpenVault, id: number): void {
  assertSettings(vault)
  const existing = vault.db.queryOne('SELECT type, name_en FROM categories WHERE id = ?', [id])
  if (!existing) throw new ValidationError('REQUIRED')
  const used = Number(vault.db.queryValue('SELECT COUNT(*) FROM transactions WHERE category_id = ?', [id]) ?? 0)
  if (used > 0) throw new ValidationError('CATEGORY_IN_USE')
  const siblings = Number(
    vault.db.queryValue('SELECT COUNT(*) FROM categories WHERE type = ?', [existing.type]) ?? 0,
  )
  if (siblings <= 1) throw new ValidationError('LAST_CATEGORY')
  vault.db.withTransaction(() => {
    writeAudit(vault.db, vault.user.id, 'CATEGORY_DELETED', 'category', String(id), { name: existing.name_en })
    vault.db.exec('DELETE FROM categories WHERE id = ?', [id])
  })
}

export function categoryInput(category: Category): CategoryInput {
  return {
    type: category.type,
    nameEn: category.nameEn,
    nameUzLatn: category.nameUzLatn,
    nameUzCyrl: category.nameUzCyrl,
    nameRu: category.nameRu,
  }
}
