import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 30_000, // Kafka connect + drain can take a few seconds
  },
});
