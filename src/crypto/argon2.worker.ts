import { argon2id } from 'hash-wasm'

type Request = { id: number; secret: Uint8Array; salt: Uint8Array; m: number; t: number; p: number }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null
  postMessage: (message: unknown, transfer?: Transferable[]) => void
}

scope.onmessage = (event) => {
  const { id, secret, salt, m, t, p } = event.data
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
