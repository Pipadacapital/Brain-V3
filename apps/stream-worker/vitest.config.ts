import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    reporters: ['verbose'],
    passWithNoTests: true,
    // Live Redpanda + Redis + PG tests need generous timeout.
    // pipeline-wire.e2e.test.ts spawns a collector subprocess with a 30s Apicurio
    // backoff window before the HTTP listener opens, so both timeouts must be higher.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
