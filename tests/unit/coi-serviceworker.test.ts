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

/** Runs coi-config.js against a stand-in page whose isolation worker becomes active when `activate` is called. */
function startConfig({ serviceWorker = true, framed = false } = {}) {
  let reloads = 0
  let activate = () => {}
  const ready = new Promise<void>((resolve) => (activate = resolve))
  const window: Record<string, unknown> = { location: { reload: () => (reloads += 1) } }
  window.self = window
  window.top = framed ? {} : window
  const context = createContext({ window, document: { baseURI: `${ORIGIN}/` }, navigator: serviceWorker ? { serviceWorker: { ready } } : {} })
  runInContext(readFileSync(join(ROOT, 'public/coi-config.js'), 'utf8'), context)
  return { coi: window.coi as { doReload: () => void; shouldRegister?: () => boolean }, reloads: () => reloads, activate }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('coi-config', () => {
  it('reloads for the isolation worker only once it is active, so the reloaded page is isolated', async () => {
    const page = startConfig()
    page.coi.doReload()
    await settle()
    expect(page.reloads()).toBe(0)
    page.activate()
    await settle()
    expect(page.reloads()).toBe(1)
  })

  it('reloads at once without service workers, and never registers inside a frame', async () => {
    const page = startConfig({ serviceWorker: false })
    page.coi.doReload()
    expect(page.reloads()).toBe(1)
    const framed = startConfig({ framed: true })
    expect(framed.coi.shouldRegister?.()).toBe(false)
    framed.activate()
    framed.coi.doReload()
    await settle()
    expect(framed.reloads()).toBe(1)
  })
})

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
