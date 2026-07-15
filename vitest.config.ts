import { defineConfig } from 'vitest/config'

// Pure unit tests of src/lib/time.ts. No DOM, no network, no Supabase — node env only.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
