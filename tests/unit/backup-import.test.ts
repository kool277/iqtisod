import { describe, expect, it } from 'vitest'
import { declaresChunkedBackup } from '../../src/components/backup-import'

describe('declaresChunkedBackup', () => {
  it('recognises a version 3 file by how the app writes its first fields', async () => {
    expect(await declaresChunkedBackup(new Blob(['{"format":"moliya-vault","version":3,"appVersion":"2.0.0"}']))).toBe(true)
    expect(await declaresChunkedBackup(new Blob(['  { "format" : "moliya-vault" , "version" : 3 }']))).toBe(true)
  })

  it('holds every other file to the single-value budget', async () => {
    for (const text of [
      '{"format":"moliya-vault","version":2,"appVersion":"1.7.3"}',
      '{"format":"moliya-vault","version":30}',
      '{"version":3,"format":"moliya-vault"}',
      '{"format":"moliya-vault","kdf":{},"version":3}',
      'not json',
      '',
    ]) {
      expect(await declaresChunkedBackup(new Blob([text])), text).toBe(false)
    }
  })
})
