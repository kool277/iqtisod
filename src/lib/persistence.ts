export type PersistenceState = 'persistent' | 'best-effort' | 'unsupported'

export async function requestPersistence(): Promise<void> {
  try {
    if (!navigator.storage?.persisted || !navigator.storage.persist) return
    if (!(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    return
  }
}

/** How long a restore or a sign-in waits for the answer before going on without it. */
export const PERSIST_WAIT_MS = 3000

/**
 * {@link requestPersistence}, waiting at most `ms`: Firefox asks the person, and its promise stays pending until they
 * answer the prompt, which they may ignore. The request itself carries on.
 */
export function requestPersistenceBriefly(ms = PERSIST_WAIT_MS): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void requestPersistence().then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export async function persistenceState(): Promise<PersistenceState> {
  try {
    if (!navigator.storage?.persisted) return 'unsupported'
    return (await navigator.storage.persisted()) ? 'persistent' : 'best-effort'
  } catch {
    return 'unsupported'
  }
}
