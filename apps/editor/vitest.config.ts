import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['bimai/**/*.test.ts'],
    environment: 'node',
  },
})
