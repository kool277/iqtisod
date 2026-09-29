const LOCK_NAME = 'moliya-vault-session'

export async function acquireSessionLock(): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) return () => undefined
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null)
          return undefined
        }
        return new Promise<void>((release) => resolve(() => release()))
      })
      .catch(reject)
  })
}
