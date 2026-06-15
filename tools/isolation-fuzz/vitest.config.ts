import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['verbose'],
    passWithNoTests: true,
    // Live Redis/PG tests may be slow; give them a generous timeout.
    testTimeout: 30_000,
  },
});
