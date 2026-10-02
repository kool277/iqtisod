import type { UserWrap } from '../domain/types'
import { WRAP_AAD_V1, unwrapDek, wrapAad, wrapDek } from './crypto.service'

export async function newUserWrap(dek: CryptoKey, kek: CryptoKey, base: Pick<UserWrap, 'userId' | 'email' | 'kdf' | 'salt'>): Promise<UserWrap> {
  const wrapped = await wrapDek(dek, kek, wrapAad(base.userId))
  return { ...base, iv: wrapped.iv, wrappedDek: wrapped.cipherText, aad: WRAP_AAD_V1 }
}

export function unwrapUserDek(wrap: UserWrap, kek: CryptoKey): Promise<CryptoKey> {
  return unwrapDek(wrap.wrappedDek, kek, wrap.iv, wrap.aad === WRAP_AAD_V1 ? wrapAad(wrap.userId) : undefined)
}
