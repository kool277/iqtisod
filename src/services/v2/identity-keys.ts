import { openIdentitySecret, seedKey, wipeSecret } from '../../crypto/identity'
import { AppError, AuthError } from '../../domain/errors'
import type { OpenVault } from '../../domain/types'
import type { KeysSession } from './session'

/**
 * The key that wraps the person's safe key, or seals their sign-in check secret, in a vault with per-person keys
 * (design 4.7 and 4.8): derived from the seed in their sealed identity, which only their password opens. A wrong
 * password is refused like at sign-in.
 */
export async function identityKey(vault: OpenVault, password: string, purpose: 'safe' | 'totp'): Promise<CryptoKey> {
  const keys = vault.keys as KeysSession | undefined
  const blob = keys?.identities[keys.memberId]
  if (!keys || !blob) throw new AuthError()
  let secret
  try {
    secret = await openIdentitySecret(blob, keys.vaultId, password)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AuthError()
  }
  try {
    return await seedKey(secret.seed, purpose)
  } finally {
    wipeSecret(secret)
  }
}
