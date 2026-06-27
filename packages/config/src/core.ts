/**
 * @brain/config — core service configuration.
 *
 * Owned by the core-service config agent. Add core-only env fields here.
 * Preserve existing default values EXACTLY (pure refactor — zero behavior change).
 */
import { z } from 'zod';
import { CommonEnvSchema, defineConfig } from './common.js';

// ── Core service env vars ─────────────────────────────────────────────────────

/**
 * Strict `=== 'true'` boolean coercion (NOT z.coerce.boolean, which treats any
 * non-empty string as true). Preserves the original `process.env['X'] === 'true'`
 * semantics: only the exact string 'true' is true; everything else (incl. unset) is false.
 */
const strictTrueBool = z
  .string()
  .optional()
  .transform((v) => v === 'true');

export const CoreEnvSchema = CommonEnvSchema.extend({
  // Self-satisfying so the memoized loader validates even when SERVICE_NAME is unset (the common
  // case — it is rarely injected per-service in dev). default() fills the literal when env omits it.
  SERVICE_NAME: z.literal('core').default('core'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // ── Identity SoR (Neo4j) — main.ts identity reader ──────────────────────────
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('neo4j'),
  /** Optional dedicated CMK for identity salt + PII-vault DEK; falls back to the connector CMK in code. */
  IDENTITY_CRYPTO_KMS_KEY_ID: z.string().optional(),

  // ── Meta CAPI passback orchestrator (main.ts) ───────────────────────────────
  /** Drives the passback send loop. Strictly === 'true' (default off). */
  CAPI_PASSBACK_ENABLED: strictTrueBool,
  CAPI_PASSBACK_WINDOW_HOURS: z.coerce.number().default(24),
  CAPI_PASSBACK_INTERVAL_MS: z.coerce.number().default(300_000),

  // ── Connector secrets (main.ts) ─────────────────────────────────────────────
  /** KMS key for per-brand connector-secret EncryptionContext isolation (dev default; prod fail-closed gate stays raw). */
  CONNECTOR_SECRETS_KMS_KEY_ID: z.string().default('alias/brain-connector-secrets-dev'),

  // ── OAuth app (non-secret) client ids — BYO-app back-compat fallbacks ────────
  SHOPIFY_CLIENT_ID: z.string().optional(),
  META_APP_ID: z.string().optional(),
  GOOGLE_ADS_CLIENT_ID: z.string().optional(),
  /** Shopify Admin API version (ShopifyAdminClient default). */
  SHOPIFY_API_VERSION: z.string().optional(),

  // ── Webhook pipeline tuning (WebhookPipeline.ts) ────────────────────────────
  WEBHOOK_IP_RATE_LIMIT_MAX: z.coerce.number().default(60),
  WEBHOOK_IP_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().default(60),
  /** WooCommerce outbound webhook delivery base URL (ConnectWooCommerceCommand). */
  BRAIN_WEBHOOK_BASE_URL: z.string().default('https://api.brain.ai'),

  // ── ML eval gate (promote-model.ts) ─────────────────────────────────────────
  /** Per-model baseline override map (raw JSON; parsed downstream, may be malformed → {}). */
  EVAL_GATE_BASELINES_JSON: z.string().optional(),

  // ── Insights + FX (analytics) ───────────────────────────────────────────────
  INSIGHT_FRESHNESS_SLO_HOURS: z.coerce.number().default(6),
  FX_CACHE_TTL_MS: z.coerce.number().default(12 * 60 * 60 * 1000),
  FX_FETCH_TIMEOUT_MS: z.coerce.number().default(8000),

  // ── Trino serving / Iceberg reads ────────────────────────────────────────────
  // Brain V4: Trino IS the serving engine (StarRocks removed). App / BFF / metric-engine
  // read brain_serving.mv_* (Trino views over Iceberg Gold/Silver) through the withSilverBrand
  // seam; a cache-miss on a known metric goes to Trino. createTrinoPool builds from these.
  TRINO_HOST: z.string().default('localhost'),
  /** Host-mapped port for Trino HTTP/JDBC (container: 8080, host: 8090 in docker-compose). */
  TRINO_PORT: z.coerce.number().default(8090),
  /** Enable result caching for Trino ad-hoc queries (default off; exploration only). */
  TRINO_ADHOC_CACHE_ENABLED: strictTrueBool,

  // ── Brain V4 SERVING cache (Redis-fronted hot metric reads over the Trino seam) ──
  // Distinct from TRINO_ADHOC_CACHE_ENABLED (ad-hoc exploration). This fronts the
  // KNOWN-metric serving reads (brain_serving.mv_* over Trino) with the analytics cache.
  /**
   * Tri-state: 'true' / 'false' explicit; UNSET → defaults ON in production, OFF in dev
   * (the default is resolved at the composition root from NODE_ENV — see main.ts). Kept as
   * an optional enum so an operator can force it either way; absent means "use the prod default".
   */
  TRINO_SERVING_CACHE_ENABLED: z.enum(['true', 'false']).optional(),
  /**
   * TTL (ms) for a cached serving read. Short by default — the AnalyticsCacheInvalidateConsumer
   * busts brand-leading keys on each Spark recompute, so TTL is just the staleness safety-net.
   */
  TRINO_SERVING_CACHE_TTL_MS: z.coerce.number().int().positive().default(30_000),
  /**
   * Serving materialization version — the trailing cache-key segment. Bumping it on a
   * serving-view rebuild invalidates every cached read without flushing Redis.
   */
  SERVING_VERSION: z.string().default('v1'),
});

export type CoreEnv = z.infer<typeof CoreEnvSchema>;

/** Memoized + frozen loader for the core service config (parsed once per process). */
export const loadCoreConfig = defineConfig(CoreEnvSchema);
