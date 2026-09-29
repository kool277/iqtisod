import { defineConfig } from 'vitest/config'
import { buildDefines, buildInfo } from './tools/build-info.ts'

export default defineConfig({
  define: buildDefines(buildInfo()),
  resolve: {
    conditions: ['node', 'import', 'default'],
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    testTimeout: 60_000,
  },
})
