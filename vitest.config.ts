import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each test file gets its own in-process Postgres (PGlite); keep files isolated.
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
