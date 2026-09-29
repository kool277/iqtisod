import type { SafeKeyring } from '../services/safe.service'
import { clearCopiedSecret } from './clipboard'

/**
 * Holds the open safes' keys for one tab. There is no separate idle timer: the keys stay until
 * {@link SafeSession.lock}, or until {@link SafeSession.follow} sees the vault lock, sign out, or change person.
 */
export type SafeSession = {
  readonly keyring: SafeKeyring | null
  adopt: (keyring: SafeKeyring) => void
  /** Returns false when the safes were already locked. */
  lock: () => boolean
  /** Locks unless `userId` is the keyring's owner and may use it. */
  follow: (userId: string | null, mustChangePassword: boolean) => boolean
}

export function createSafeSession(): SafeSession {
  let current: SafeKeyring | null = null
  const lock = () => {
    if (!current) return false
    current.openSafes.clear()
    current = null
    clearCopiedSecret()
    return true
  }
  return {
    get keyring() {
      return current
    },
    adopt(keyring) {
      if (current && current !== keyring) current.openSafes.clear()
      current = keyring
    },
    lock,
    follow(userId, mustChangePassword) {
      if (!current) return false
      if (current.userId === userId && !mustChangePassword) return false
      return lock()
    },
  }
}
