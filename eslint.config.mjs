/**
 * Flat ESLint config — enforces the modular-monolith boundaries (doc 05 §7).
 * The "modular monolith" is only real if the boundaries are mechanically enforced.
 *
 * Rules implemented (Track A, Sprint 0):
 *  1. App-to-app imports are banned (I-E05).
 *  2. Cross-module reach-around past index.ts is banned.
 *  3. metric-engine importable only by analytics + measurement modules.
 *  4. no-raw-redis-key: ban key construction outside brandKey() (NN-7).
 *  5. no-float-money: ban float money types and arithmetic (I-S07).
 */
import boundaries from 'eslint-plugin-boundaries';
import tsParser from '@typescript-eslint/parser';
import noFloatMoney from './tools/eslint-rules/no-float-money.mjs';
import noRawRedisKey from './tools/eslint-rules/no-raw-redis-key.mjs';

export default [
  // Generated / build output — never lint.
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      'packages/contracts/generated/**',
    ],
  },

  // ── TypeScript source files ───────────────────────────────────────────────
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      boundaries,
      'brain-money': { rules: { 'no-float-money': noFloatMoney } },
      'brain-redis': { rules: { 'no-raw-redis-key': noRawRedisKey } },
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      /**
       * Element types for eslint-plugin-boundaries.
       * We declare coarse element types so the boundary rules can fire.
       */
      'boundaries/elements': [
        // Each deployable app — captured by the top-level directory name
        { type: 'app', pattern: 'apps/*', capture: ['app'] },
        // Core bounded-context modules (internal to core)
        { type: 'core-module', pattern: 'apps/core/src/modules/*', capture: ['module'] },
        // Shared packages
        { type: 'metric-engine', pattern: 'packages/metric-engine', capture: [] },
        { type: 'package', pattern: 'packages/*', capture: ['pkg'] },
        // Tools are internal-only; not importable from apps or packages
        { type: 'tool', pattern: 'tools/*', capture: ['tool'] },
      ],
      'boundaries/ignore': ['**/*.test.ts', '**/*.spec.ts', '**/fixtures/**'],
    },
    rules: {
      // ── Rule 1: apps may not import other apps (I-E05) ──────────────────
      'boundaries/element-types': [
        'error',
        {
          default: 'allow',
          rules: [
            // Apps may not import other apps (cross-deployable coupling banned)
            {
              from: ['app'],
              disallow: ['app'],
              message: 'App "${from.app}" may not import app "${to.app}". Cross-deployable coupling is banned (I-E05).',
            },
            // Tools may not be imported by apps or packages
            {
              from: ['app', 'package', 'core-module', 'metric-engine'],
              disallow: ['tool'],
              message: 'Tools must not be imported from application or package code.',
            },
            // metric-engine may only be imported by analytics and measurement modules
            {
              from: ['core-module'],
              disallow: ['metric-engine'],
              message: 'packages/metric-engine is fenced to analytics + measurement modules only (I-ST03).',
            },
          ],
        },
      ],

      // ── Rule 2: Cross-module reach-around guard ──────────────────────────
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Block imports that reach past the module's index.ts into internals
              group: ['apps/core/src/modules/*/internal/*', 'apps/core/src/modules/*/*/**'],
              message:
                "Cross-module reach-around past index.ts is banned (I-E05). Import only from the module's public index.ts.",
            },
          ],
        },
      ],

      // ── Rule 4: NN-7 — ban raw Redis key construction ────────────────────
      'brain-redis/no-raw-redis-key': 'error',

      // ── Rule 5: I-S07 — ban float money types and arithmetic ─────────────
      'brain-money/no-float-money': 'error',
    },
  },

  // ── Test/fixture files — relax float-money to warn ───────────────────────
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/fixtures/**/*.ts'],
    rules: {
      'brain-money/no-float-money': 'warn',
    },
  },
];
