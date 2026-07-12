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
 *  6. no-pci-card-fields: ban card-network field names outside the mapper boundary (C4 / PCI SAQ-A / ADR-RZ-10).
 */
import boundaries from 'eslint-plugin-boundaries';
import reactHooks from 'eslint-plugin-react-hooks';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import noFloatMoney from './tools/eslint-rules/no-float-money.mjs';
import noRawRedisKey from './tools/eslint-rules/no-raw-redis-key.mjs';
import noPciCardFields from './tools/eslint-rules/no-pci-card-fields.mjs';

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
      // Registered so rule NAMES resolve: files carry
      // `eslint-disable @typescript-eslint/no-explicit-any` comments, and an
      // unregistered plugin makes ESLint 9 hard-error "Definition for rule
      // not found" on every such comment (broke lint tree-wide on the first
      // post-migration CI run). No @typescript-eslint rules are ENABLED —
      // registration is name-resolution only.
      '@typescript-eslint': tsPlugin,
      'brain-money': { rules: { 'no-float-money': noFloatMoney } },
      'brain-redis': { rules: { 'no-raw-redis-key': noRawRedisKey } },
      'brain-pci':   { rules: { 'no-pci-card-fields': noPciCardFields } },
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
        // ORDER MATTERS: eslint-plugin-boundaries matches the FIRST descriptor whose pattern
        // matches, so the MOST SPECIFIC patterns must come first. Previously `app` (apps/*)
        // preceded `core-module` (apps/core/src/modules/*), so every core file classified as
        // `app` and the core-module fences never fired (audit RS-1). Specific → general:
        // Core bounded-context modules (internal to core) — most specific apps/* path.
        { type: 'core-module', pattern: 'apps/core/src/modules/*', capture: ['module'] },
        // The metric engine — more specific than the generic package pattern.
        { type: 'metric-engine', pattern: 'packages/metric-engine', capture: [] },
        // Hexagonal DOMAIN packages (Commerce-OS program, SPEC: 0.5) — pure domain logic with
        // ports only. More specific than the generic package pattern. Wave B's domain-journey
        // is the first occupant; every future packages/domain-* lands inside this zone.
        { type: 'domain', pattern: 'packages/domain-*', capture: ['domain'] },
        // Each deployable app — captured by the top-level directory name.
        { type: 'app', pattern: 'apps/*', capture: ['app'] },
        // Shared packages.
        { type: 'package', pattern: 'packages/*', capture: ['pkg'] },
        // Tools are internal-only; not importable from apps or packages.
        { type: 'tool', pattern: 'tools/*', capture: ['tool'] },
      ],
      'boundaries/ignore': ['**/*.test.ts', '**/*.spec.ts', '**/fixtures/**'],
      // Resolve workspace `@brain/*` package imports to their real packages/* path so the
      // boundary rules can classify them (e.g. `@brain/metric-engine` → the metric-engine
      // element). Without this the metric-engine fence is inert for package-specifier imports
      // (audit RS-1). The TS resolver follows the workspace package.json "main".
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: ['tsconfig.base.json', 'apps/*/tsconfig.json', 'packages/*/tsconfig.json'],
        },
        node: true,
      },
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
              from: ['app', 'package', 'core-module', 'metric-engine', 'domain'],
              disallow: ['tool'],
              message: 'Tools must not be imported from application or package code.',
            },
            // HEXAGONAL RULE (SPEC: 0.5): domain packages hold pure domain logic + ports; all
            // datastore access arrives through injected adapters. They may not import the
            // in-repo infrastructure adapter packages: @brain/db (the PG client wrapper) or
            // @brain/metric-engine (the Trino serving seam). External driver imports (kafkajs,
            // ioredis, neo4j-driver, pg, …) are banned by boundaries/external below.
            {
              from: ['domain'],
              disallow: ['metric-engine', ['package', { pkg: 'db' }]],
              message:
                'Hexagonal boundary (SPEC: 0.5): packages/domain-* must not import infrastructure ' +
                'adapters (@brain/db, @brain/metric-engine). Define a port in the domain package and ' +
                'inject the adapter at the composition root.',
            },
            // metric-engine is fenced to the MEASUREMENT TIER — the modules that legitimately
            // consume the metric registry/engine: measurement, analytics, attribution (credit
            // via the engine seams), data-quality (metric trust), ai (NLQ → certified registry
            // bindings), and frontend-api (the BFF that orchestrates the analytics read path).
            // Every OTHER core-module (identity, workspace-access, connector, notification,
            // pixel, billing, recommendation, …) must NOT import the metric engine directly.
            // (audit RS-1: this fence was inert — descriptor order + missing resolver, both fixed.)
            {
              from: [
                ['core-module', { module: '!(measurement|analytics|attribution|data-quality|ai|frontend-api)' }],
              ],
              disallow: ['metric-engine'],
              message:
                'packages/metric-engine is fenced to the measurement tier (measurement, analytics, ' +
                'attribution, data-quality, ai, frontend-api) — I-ST03, D-6. This module must not ' +
                'import the metric engine directly; go through the analytics module instead.',
            },
          ],
        },
      ],

      // ── HEXAGONAL RULE (SPEC: 0.5) — external infrastructure clients ─────
      // Domain packages (packages/domain-*) must not import infrastructure driver
      // libraries directly: Kafka (kafkajs), Redis (ioredis/redis), Neo4j
      // (neo4j-driver), PostgreSQL (pg), Trino (trino-client / presto-client —
      // Trino access in this repo is the @brain/metric-engine seam, banned above).
      // Domain code programs against its own PORT interfaces; the composition root
      // injects the concrete adapter.
      'boundaries/external': [
        'error',
        {
          default: 'allow',
          rules: [
            {
              from: ['domain'],
              disallow: [
                'kafkajs',
                'ioredis',
                'redis',
                'neo4j-driver',
                'pg',
                'pg-pool',
                'pg-cursor',
                'trino-client',
                'presto-client',
              ],
              message:
                'Hexagonal boundary (SPEC: 0.5): packages/domain-* must not import infrastructure ' +
                'clients (kafka/redis/neo4j/pg/trino). Define a port in the domain package and inject ' +
                'the adapter at the composition root.',
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
              // Block reaching past ANOTHER module's index.ts into its internals. The reach-around
              // always goes UP out of the current module (../) and into a sibling module's
              // `internal/` — at varying depths. (audit ARC-1: the old absolute-style globs
              // `apps/core/src/modules/*/internal/*` never matched the relative `../../` specifiers
              // actually used, so this guard was dead.) These relative patterns match the real
              // reach-around form while allowing `./internal/...` (a module's own index → its own
              // internal) and `../<x>` (within-module navigation, no sibling `internal/`).
              group: [
                '../*/internal/**',
                '../../*/internal/**',
                '../../../*/internal/**',
                '../../../../*/internal/**',
              ],
              message:
                "Cross-module reach-around past index.ts is banned (I-E05). Import only from the target module's public index.ts.",
            },
          ],
        },
      ],

      // ── Rule 4: NN-7 — ban raw Redis key construction ────────────────────
      'brain-redis/no-raw-redis-key': 'error',

      // ── Rule 5: I-S07 — ban float money types and arithmetic ─────────────
      'brain-money/no-float-money': 'error',

      // ── Rule 6: C4 / PCI SAQ-A — ban card-network field names (ADR-RZ-10) ─
      // The mapper (packages/razorpay-mapper/src/index.ts) is the primary control;
      // this rule is the mandatory CI belt-and-suspenders gate (C4.4).
      // The mapper's applyFieldAllowlist / CARD_FIELDS_BLOCKED carry eslint-disable
      // comments because that file IS the authoritative drop boundary.
      'brain-pci/no-pci-card-fields': 'error',
    },
  },

  // ── Test/fixture files — relax float-money to warn ───────────────────────
  {
    files: ['**/*.test.ts', '**/*.spec.ts', '**/fixtures/**/*.ts'],
    rules: {
      'brain-money/no-float-money': 'warn',
      // White-box tests legitimately reach into a module's internals to build fixtures /
      // assert on domain entities. The reach-around guard protects PRODUCTION boundaries
      // (consistent with boundaries/ignore, which already excludes tests).
      'no-restricted-imports': 'off',
    },
  },

  // ── AUD-IMPL-002: promise safety for the Fastify/KafkaJS services ─────────
  // tsc strict does NOT flag un-awaited promises; a dropped promise in an ingest/consumer
  // loop silently swallows failures (event-loss risk). Type-aware, so scoped to the three
  // service src trees to keep lint fast. projectService resolves each file's real tsconfig.
  {
    files: [
      'apps/core/src/**/*.ts',
      'apps/collector/src/**/*.ts',
      'apps/stream-worker/src/**/*.ts',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },

  // ── AUD-IMPL-002: react-hooks correctness for the Next.js app ─────────────
  // Catches conditional hook calls (rules-of-hooks) and stale-closure dependency bugs
  // (exhaustive-deps) that tsc cannot see.
  {
    files: ['apps/web/**/*.ts', 'apps/web/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
];
