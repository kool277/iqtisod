import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { OpenVault, TransactionInput } from '../../src/domain/types'
import { LIMITS } from '../../src/lib/limits'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { createTransaction, deleteTransaction, listCategories, listTransactions } from '../../src/services/finance.service'
import { listGroups } from '../../src/services/group.service'

const MIB = 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ADMIN = { email: 'admin@example.com', password: 'correct-horse' }

/** A receipt of about 1.9 MB as stored: the data URL of 1.4 MiB of "PNG". */
const receipt = () => `data:image/png;base64,${Buffer.concat([PNG_SIGNATURE, randomBytes(1.4 * MIB)]).toString('base64')}`

const open: OpenVault[] = []

afterEach(() => {
  for (const vault of open) vault.db.close()
  open.length = 0
})

describe('a vault that reached its size limit', () => {
  it('takes receipts again once others are removed, and gives the space back when it is saved', async () => {
    const { vault } = await createVault({ ...ADMIN, displayName: 'Home', currency: 'USD' })
    open.push(vault)
    const expense = listCategories(vault).find((category) => category.nameEn === 'Food')!
    const input = (receiptData: string): TransactionInput => ({
      type: 'EXPENSE',
      amount: '1',
      currency: 'USD',
      categoryId: expense.id,
      groupId: listGroups(vault)[0].id,
      date: '2026-09-15',
      notes: '',
      receiptData,
    })

    const ids: string[] = []
    let refused: unknown = null
    for (let attempt = 0; attempt < 60 && !refused; attempt += 1) {
      try {
        ids.push(createTransaction(vault, input(receipt())))
      } catch (error) {
        refused = error
      }
    }
    expect(refused).toMatchObject({ code: 'VAULT_FULL' })
    const full = vault.db.sizeBytes()
    expect(full).toBeLessThanOrEqual(LIMITS.databaseBudgetBytes)

    // Removing receipts frees pages inside the file but does not shrink it; new receipts fill those pages.
    for (const id of ids.splice(0, 4)) deleteTransaction(vault, id)
    expect(vault.db.sizeBytes()).toBe(full)
    expect(vault.db.freeBytes()).toBeGreaterThan(4 * MIB)
    ids.push(createTransaction(vault, input(receipt())))
    expect(vault.db.sizeBytes()).toBe(full)

    // Saving gives the free pages back once they are 4 MiB or more.
    for (const id of ids.splice(0, 6)) deleteTransaction(vault, id)
    const sealed = await sealVault(vault)
    expect(vault.db.freeBytes()).toBe(0)
    expect(vault.db.sizeBytes()).toBeLessThan(full - 8 * MIB)
    expect(sealed.body.ciphertext.byteLength).toBe(vault.db.sizeBytes() + 16)

    const reopened = await unlockVault(sealed, ADMIN.email, ADMIN.password)
    open.push(reopened)
    expect(listTransactions(reopened, { start: '2026-09-01', end: '2026-09-30' }).map((row) => row.id).sort()).toEqual([...ids].sort())
  })

  it('keeps a few freed pages rather than rewriting the file on every save', async () => {
    const { vault } = await createVault({ ...ADMIN, displayName: 'Home', currency: 'USD' })
    open.push(vault)
    const expense = listCategories(vault).find((category) => category.nameEn === 'Food')!
    const base = { type: 'EXPENSE' as const, amount: '1', currency: 'USD', categoryId: expense.id, groupId: listGroups(vault)[0].id, date: '2026-09-15', notes: '' }
    const ids = Array.from({ length: 8 }, () => createTransaction(vault, { ...base, receiptData: receipt() }))
    deleteTransaction(vault, ids[0])
    const free = vault.db.freeBytes()
    expect(free).toBeGreaterThan(MIB)
    await sealVault(vault)
    expect(vault.db.freeBytes()).toBe(free)
  })
})
