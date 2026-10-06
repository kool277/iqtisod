import { argon2id } from 'hash-wasm'
import { readArgon2Request } from './argon2-request'

const scope = self as unknown as {
  location: { origin: string }
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = (event) => {
  if (event.origin !== '' && event.origin !== scope.location.origin) return
  const request = readArgon2Request(event, scope.location.origin)
  if (!request) {
    const id = (event.data as { id?: unknown } | null)?.id
    if (Number.isSafeInteger(id)) scope.postMessage({ id, error: 'BAD_REQUEST' })
    return
  }
  const { id, secret, salt, m, t, p } = request
  argon2id({ password: secret, salt, parallelism: p, iterations: t, memorySize: m, hashLength: 32, outputType: 'binary' }).then(
    (bits) => {
      secret.fill(0)
      scope.postMessage({ id, bits }, [bits.buffer])
    },
    (error: unknown) => {
      secret.fill(0)
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    },
  )
}
