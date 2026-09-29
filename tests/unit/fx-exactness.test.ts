import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const EXACT_PATHS = [
  'src/lib/decimal.ts',
  'src/domain/fx.ts',
  'src/services/fx.service.ts',
  'src/components/ExchangeRates.tsx',
  'tools/fx-sources.ts',
  'tools/fetch-rates.ts',
]

describe('exchange-rate code never uses floating point for money', () => {
  it.each(EXACT_PATHS)('%s has no float parsing, float formatting, or float rounding', (file) => {
    const source = readFileSync(resolve(ROOT, file), 'utf8')
    expect(source).not.toMatch(/parseFloat|parseInt|Number\(|\.toFixed\(|\.toPrecision\(|Math\.(round|floor|ceil|pow|trunc)|toMajor|formatMoney/)
  })

  it('keeps the shared modules loadable by Node without a bundler', () => {
    for (const file of ['src/domain/fx.ts', 'src/lib/decimal.ts', 'src/lib/sha256.ts', 'tools/fx-sources.ts', 'tools/fetch-rates.ts']) {
      const source = readFileSync(resolve(ROOT, file), 'utf8')
      for (const [, specifier] of source.matchAll(/^import (?!type ).*from '(\.[^']+)'/gm)) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/\.ts$/)
      }
    }
  })
})
