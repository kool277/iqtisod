import type { OpenVault } from '../../domain/types'
import { readProfiles } from '../user-profile'

/** Who would need a new invite after the founder upgrade: everyone else who is not suspended or a former member. */
export function upgradeReinvites(vault: OpenVault): number {
  const profiles = readProfiles(vault.db)
  return vault.db
    .query('SELECT id FROM users WHERE id <> ?', [vault.user.id])
    .filter((row) => (profiles.get(String(row.id))?.status ?? 'ACTIVE') === 'ACTIVE').length
}
