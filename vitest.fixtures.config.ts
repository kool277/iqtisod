import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    conditions: ['node', 'import', 'default'],
  },
  test: {
    environment: 'node',
    include: ['tools/fixtures/**/*.gen.ts'],
    testTimeout: 120_000,
    fileParallelism: false,
  },
})
