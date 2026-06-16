import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['verbose'],
    passWithNoTests: true,
    // Live Redpanda + Redis + PG tests need generous timeout
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
