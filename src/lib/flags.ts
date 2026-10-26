/**
 * Build flags. Setup creates per-person-keys vaults and admins of a 1.x vault are offered the upgrade unless the build
 * sets `VITE_V2_KEYS=0` (docs/design/v2.0-key-redesign.md, 9), which makes setup create 1.x vaults again. Opening,
 * checking and editing a version 3 record never depends on it: readers never drop a version.
 */
export function keysEnabled(): boolean {
  return import.meta.env.VITE_V2_KEYS !== '0'
}
