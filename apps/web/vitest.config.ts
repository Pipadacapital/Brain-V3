import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for @brain/web unit tests.
 *
 * IMPORTANT: The e2e/ directory contains Playwright specs — they must be
 * excluded from Vitest discovery to avoid the "Playwright Test did not expect
 * test() to be called here" collision. Playwright tests run via `test:e2e`
 * (playwright test), not `test:unit` (vitest run).
 */
export default defineConfig({
  test: {
    // Vitest default include would pick up e2e/smoke.spec.ts — exclude it.
    exclude: [
      'e2e/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
    ],
    // Keep the same pass-with-no-tests semantics as the CLI flag.
    passWithNoTests: true,
    environment: 'node',
  },
});
