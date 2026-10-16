/**
 * Build flags. `VITE_V2_KEYS=1` at build time lets setup create per-person-keys vaults and offers admins of a 1.x vault
 * the upgrade (docs/design/v2.0-key-redesign.md, 9). Opening, checking and editing a version 3 record never depends on
 * it: readers never drop a version, so a 2.0 backup opens in any build that has the reader.
 */
export function keysEnabled(): boolean {
  return import.meta.env.VITE_V2_KEYS === '1'
}
