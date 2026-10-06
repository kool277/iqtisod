import { ValidationError } from '../domain/errors'
import { isArgon2Params, type Argon2Params } from './kdf'

type Pending = { resolve: (bits: Uint8Array) => void; reject: (error: Error) => void }

let worker: Worker | null = null
let workerFailed = false
let nextId = 1
const pending = new Map<number, Pending>()

function failAll(message: string): void {
  for (const entry of pending.values()) entry.reject(new ValidationError(message))
  pending.clear()
}

function startWorker(): Worker | null {
  if (worker || workerFailed) return worker
  if (typeof Worker !== 'function' || typeof window === 'undefined') return null
  try {
    worker = new Worker(new URL('./argon2.worker.ts', import.meta.url), { type: 'module', name: 'argon2' })
  } catch {
    workerFailed = true
    return null
  }
  worker.onmessage = (event: MessageEvent<{ id: number; bits?: Uint8Array; error?: string }>) => {
    const entry = pending.get(event.data.id)
    if (!entry) return
    pending.delete(event.data.id)
    if (event.data.bits) entry.resolve(event.data.bits)
    else entry.reject(new ValidationError('KDF_MEMORY'))
  }
  worker.onerror = () => {
    worker?.terminate()
    worker = null
    workerFailed = true
    failAll('KDF_MEMORY')
  }
  return worker
}

/** Starts the Worker and its WASM download while the person is still typing. */
export function prewarmArgon2(): void {
  startWorker()
}

async function inline(secret: Uint8Array, salt: Uint8Array, kdf: Argon2Params): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm')
  try {
    return await argon2id({ password: secret, salt, parallelism: kdf.p, iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' })
  } catch {
    throw new ValidationError('KDF_MEMORY')
  } finally {
    secret.fill(0)
  }
}

/** Argon2id in a Worker (browser) or inline (Node, tests). The parameters are bounds-checked before anything is allocated. */
export async function argon2idBits(secret: string | Uint8Array, salt: Uint8Array, kdf: Argon2Params): Promise<Uint8Array> {
  if (!isArgon2Params(kdf)) throw new Error('Unsupported key derivation parameters')
  const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : Uint8Array.from(secret)
  const saltCopy = Uint8Array.from(salt)
  const active = startWorker()
  if (!active) return inline(bytes, saltCopy, kdf)
  const id = nextId++
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    active.postMessage({ id, secret: bytes, salt: saltCopy, m: kdf.m, t: kdf.t, p: kdf.p }, [bytes.buffer, saltCopy.buffer])
  })
}
