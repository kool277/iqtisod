export const LEDGER_GROUP_PARAM = 'group'

/** `#/app/transactions?group=<id>`: the ledger with its group filter already applied. */
export function ledgerPathForGroup(groupId: number): string {
  return `/app/transactions?${LEDGER_GROUP_PARAM}=${groupId}`
}

/**
 * The group a ledger link asks for, or null when the value is malformed or not one of `allowed`.
 * The filter only ever narrows rows the reader can already see; an unknown id is ignored rather than trusted.
 */
export function linkedGroup(value: string | null, allowed: readonly { id: number }[]): number | null {
  if (value == null || !/^[1-9]\d{0,15}$/.test(value)) return null
  const id = Number(value)
  return allowed.some((group) => group.id === id) ? id : null
}
