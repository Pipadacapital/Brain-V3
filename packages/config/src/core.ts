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
  SERVICE_NAME: z.literal('core'),
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

  // ── StarRocks Silver/Gold read pool (shared by jobs) ────────────────────────
  STARROCKS_HOST: z.string().default('localhost'),
  STARROCKS_PORT: z.coerce.number().default(9030),
  STARROCKS_ANALYTICS_USER: z.string().default('brain_analytics'),
  STARROCKS_ANALYTICS_PASSWORD: z.string().default('brain_analytics_dev'),
  /** Iceberg Bronze catalog name (env-overridable so prod can point at the Glue catalog). */
  STARROCKS_BRONZE_CATALOG: z.string().default('brain_bronze_local'),

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
});

export type CoreEnv = z.infer<typeof CoreEnvSchema>;

/** Memoized + frozen loader for the core service config (parsed once per process). */
export const loadCoreConfig = defineConfig(CoreEnvSchema);
