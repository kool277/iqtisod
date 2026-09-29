export type PersistenceState = 'persistent' | 'best-effort' | 'unsupported'

export async function requestPersistence(): Promise<void> {
  try {
    if (!navigator.storage?.persisted || !navigator.storage.persist) return
    if (!(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    return
  }
}

export async function persistenceState(): Promise<PersistenceState> {
  try {
    if (!navigator.storage?.persisted) return 'unsupported'
    return (await navigator.storage.persisted()) ? 'persistent' : 'best-effort'
  } catch {
    return 'unsupported'
  }
}
