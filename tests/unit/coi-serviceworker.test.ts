import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '../..')
const ORIGIN = 'https://jaybi.uz'

/** Runs the vendored worker script against a stand-in `self`, as a browser would start it. */
function startWorker() {
  const listeners = new Map<string, (event: unknown) => void>()
  let unregistered = 0
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting: () => undefined,
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: {
      unregister: () => {
        unregistered += 1
        return Promise.resolve(true)
      },
    },
  }
  const context = createContext({ self })
  runInContext(readFileSync(join(ROOT, 'public/coi-serviceworker.js'), 'utf8'), context)
  return {
    post: (data: unknown, origin: string) => listeners.get('message')!({ data, origin }),
    credentialless: () => runInContext('coepCredentialless', context) as boolean,
    unregistered: () => unregistered,
  }
}

describe('coi-serviceworker', () => {
  it('follows messages from pages of its own origin', () => {
    const worker = startWorker()
    worker.post({ type: 'coepCredentialless', value: true }, ORIGIN)
    expect(worker.credentialless()).toBe(true)
    worker.post({ type: 'deregister' }, ORIGIN)
    expect(worker.unregistered()).toBe(1)
  })

  // The local change to the vendored file; make it again after updating coi-serviceworker (docs/devops-guide.md).
  it('ignores messages from any other origin', () => {
    const worker = startWorker()
    for (const origin of ['https://example.com', 'http://jaybi.uz', 'null', '']) {
      worker.post({ type: 'coepCredentialless', value: true }, origin)
      worker.post({ type: 'deregister' }, origin)
    }
    expect(worker.credentialless()).toBe(false)
    expect(worker.unregistered()).toBe(0)
  })
})
