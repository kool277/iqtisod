import { defineConfig } from 'vitest/config'
import { buildDefines, buildInfo } from '../../../tools/build-info.ts'

/** Runs the scripts that forge vaults for the browser tests with the app's own code (see `*.forge.ts`). */
export default defineConfig({
  define: buildDefines(buildInfo()),
  resolve: {
    conditions: ['node', 'import', 'default'],
  },
  test: {
    environment: 'node',
    include: ['tests/e2e/forge/*.forge.ts'],
    testTimeout: 120_000,
  },
})
