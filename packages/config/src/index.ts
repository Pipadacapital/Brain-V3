// prod go-live 2026-07-11: first CI build of the app images (retry with the
// TURBO_SCM_BASE fix in deploy.yml) — touch @brain/config so turbo --affected
// rebuilds collector/core/stream-worker (harmless comment).
/**
 * @brain/config — Zod-validated environment configuration.
 *
 * The single source of record for configurable values across the Brain monorepo.
 *
 * Pattern: parse env vars at startup, crash on invalid config (process.exit(1)).
 * This ensures misconfigured services fail immediately rather than silently.
 *
 * Usage (per-service memoized loaders parse once + freeze):
 *   import { loadCoreConfig } from '@brain/config';
 *   const cfg = loadCoreConfig(); // throws / exits on missing required vars
 *
 * File ownership (disjoint — each service owns its own file):
 *   - common.ts        → CommonEnvSchema, requireEnvInProd, parseEnv, defineConfig
 *   - core.ts          → CoreEnvSchema, loadCoreConfig
 *   - collector.ts     → CollectorEnvSchema, loadCollectorConfig
 *   - stream-worker.ts → StreamWorkerEnvSchema, loadStreamWorkerConfig
 *   - web.ts           → WebEnvSchema, loadWebConfig
 *
 * This barrel preserves every previously-exported name so existing imports keep working.
 */
export * from './common.js';
export * from './core.js';
export * from './collector.js';
export * from './stream-worker.js';
export * from './web.js';
