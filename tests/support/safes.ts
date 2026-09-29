import type { VaultRecord } from '../../src/db/envelope'
import type { CardFields, NoteFields, SubscriptionFields } from '../../src/domain/safes'
import type { OpenVault } from '../../src/domain/types'
import { changeOwnPassword } from '../../src/services/account.service'
import { createVault, sealVault, unlockVault } from '../../src/services/auth.service'
import { listGroups } from '../../src/services/group.service'
import { createUser } from '../../src/services/user.service'

export const ADMIN = { email: 'admin@example.com', password: 'admin-password-1' }
export const MANAGER = { email: 'manager@example.com', initial: 'set-by-admin-1', password: 'manager-own-pass-1' }

export const CARD_NUMBER = '4111111111111111'
export const CARD: CardFields & { title: string } = {
  kind: 'CARD',
  title: 'Family Visa',
  cardholder: 'Aziza Karimova',
  number: '4111 1111 1111 1111',
  brand: 'VISA',
  expMonth: 8,
  expYear: 2029,
  cvv: '737',
  bank: 'Kapitalbank',
  notes: '',
}
export const SUBSCRIPTION: SubscriptionFields & { title: string } = {
  kind: 'SUBSCRIPTION',
  title: 'Netflix',
  url: 'https://www.netflix.com/',
  amountMinor: 999,
  currency: 'USD',
  cycle: 'MONTHLY',
  customDays: null,
  anchorDate: '2026-09-05',
  status: 'ACTIVE',
  trialEndsOn: null,
  remindDaysBefore: 3,
  cardItemId: null,
  account: 'aziza@example.com',
  notes: '',
}
export const NOTE_BODY = 'Safe deposit box 42 at the Chilonzor branch'
export const NOTE: NoteFields & { title: string } = { kind: 'NOTE', title: 'Deposit box', body: NOTE_BODY }
export const SAFE_NAME = 'Family gold'

const opened: OpenVault[] = []

export function track(vault: OpenVault): OpenVault {
  opened.push(vault)
  return vault
}

export function closeTracked(): void {
  for (const vault of opened.splice(0)) vault.db.close()
}

export async function open(record: VaultRecord, email: string, password: string): Promise<OpenVault> {
  return track(await unlockVault(record, email, password))
}

/** A vault with an Admin and a Manager who already replaced the password the Admin chose. */
export async function buildHousehold(): Promise<VaultRecord> {
  const created = await createVault({ email: ADMIN.email, password: ADMIN.password, displayName: 'Home', currency: 'USD' })
  track(created.vault)
  await createUser(created.vault, {
    email: MANAGER.email,
    password: MANAGER.initial,
    roleName: 'Manager',
    groupId: listGroups(created.vault)[0].id,
  })
  const withManager = await sealVault(created.vault)
  const manager = await open(withManager, MANAGER.email, MANAGER.initial)
  await changeOwnPassword(manager, MANAGER.initial, MANAGER.password)
  return sealVault(manager)
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer
    }
    return true
  }
  return false
}
