import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestPersistenceBriefly } from '../../src/lib/persistence'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('requestPersistenceBriefly', () => {
  it('stops waiting for a prompt nobody answers, as Firefox leaves it', async () => {
    const persist = vi.fn(() => new Promise<boolean>(() => undefined))
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist } })
    const started = Date.now()
    await requestPersistenceBriefly(50)
    expect(persist).toHaveBeenCalledOnce()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('goes on as soon as the browser answers', async () => {
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => true } })
    await expect(requestPersistenceBriefly(60_000)).resolves.toBeUndefined()
  }, 2000)

  it('does not ask again once data is persistent, or where the browser cannot', async () => {
    const persist = vi.fn(async () => true)
    vi.stubGlobal('navigator', { storage: { persisted: async () => true, persist } })
    await requestPersistenceBriefly(60_000)
    expect(persist).not.toHaveBeenCalled()
    vi.stubGlobal('navigator', {})
    await expect(requestPersistenceBriefly(60_000)).resolves.toBeUndefined()
  }, 2000)
})
