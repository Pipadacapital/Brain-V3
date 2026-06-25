/**
 * @brain/config — collector service configuration.
 *
 * Owned by the collector-service config agent. Add collector-only env fields here.
 * Preserve existing default values EXACTLY (pure refactor — zero behavior change).
 */
import { z } from 'zod';
import { CommonEnvSchema, defineConfig } from './common.js';

// ── Collector env vars ────────────────────────────────────────────────────────

export const CollectorEnvSchema = CommonEnvSchema.extend({
  SERVICE_NAME: z.literal('collector').default('collector'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDPANDA_BROKERS: z.string().min(1),
  REDPANDA_SASL_USERNAME: z.string().optional(),
  REDPANDA_SASL_PASSWORD: z.string().optional(),
  APICURIO_REGISTRY_URL: z.string().url().optional(),
  /** Rate limit: max events per brand per minute. */
  RATE_LIMIT_EVENTS_PER_MINUTE: z.coerce.number().int().min(1).default(10_000),
  /**
   * Spool back-pressure (C4 / R-09). High-water mark on the pending spool backlog: at or above
   * this depth, /collect sheds load with 503 SPOOL_FULL + Retry-After so the spool cannot grow
   * unbounded and fill the Postgres volume (which would fail the durability anchor for everyone).
   */
  SPOOL_MAX_PENDING: z.coerce.number().int().min(1).default(100_000),
  /** Low-water mark: back-pressure clears once the backlog recedes below this (hysteresis; must be < SPOOL_MAX_PENDING). */
  SPOOL_RESUME_PENDING: z.coerce.number().int().min(0).default(80_000),
  /** Background gauge refresh cadence (ms) for the back-pressure sampler. */
  SPOOL_SAMPLE_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  /** Retry-After (seconds) returned on a 503 SPOOL_FULL. */
  SPOOL_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).default(5),

  // ── Apicurio ────────────────────────────────────────────────────────────────
  /**
   * Legacy fallback registry URL used only when APICURIO_REGISTRY_URL is unset
   * (`cfg.APICURIO_REGISTRY_URL ?? cfg.APICURIO_URL`). Default 'http://localhost:8080'.
   */
  APICURIO_URL: z.string().default('http://localhost:8080'),

  // ── Drainer (D-1 async drain loop) ───────────────────────────────────────────
  /** Drainer poll interval (ms) between spool→Redpanda drain passes. */
  DRAIN_POLL_INTERVAL_MS: z.coerce.number().int().min(1).default(1_000),
  /** Number of spooled rows drained → produced per pass. */
  DRAIN_BATCH_SIZE: z.coerce.number().int().min(1).default(100),

  // ── Edge abuse protection (REC-9) ────────────────────────────────────────────
  /** Edge rate limit: max requests per install_token per window. */
  EDGE_RATE_MAX_PER_WINDOW: z.coerce.number().int().min(1).default(600),
  /** Edge rate limit window (ms). */
  EDGE_RATE_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
  /** Comma-separated origin allowlist; empty string ⇒ no allowlist (all origins). */
  EDGE_ORIGIN_ALLOWLIST: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter((o) => o.length > 0)),

  // ── Spool retention reaper (DB-AUDIT M6) ─────────────────────────────────────
  /** Drained-row trail window (seconds) before the reaper purges them. Default 24h. */
  SPOOL_RETENTION_SECONDS: z.coerce.number().int().min(1).default(86_400),
  /** Spool reaper run cadence (ms). Default every 5 min. */
  SPOOL_REAP_INTERVAL_MS: z.coerce.number().int().min(1).default(300_000),

  // ── Pixel asset / first-party cookie ─────────────────────────────────────────
  /**
   * Set the brain_anon_id as a server-set first-party cookie on /collect.
   * Strict ==='true' semantics (NOT z.coerce.boolean, which treats any non-empty string as true).
   */
  PIXEL_FIRST_PARTY_COOKIE: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  /** Fallback ingest base URL stamped into served pixel.js when no request origin is derivable. */
  PIXEL_INGEST_BASE_URL: z.string().default(''),
  /**
   * Raw default-consent signal. The route applies default-granted consent only when this
   * equals exactly 'granted' (kept as a raw string so the ==='granted' comparison is unchanged).
   */
  PIXEL_CONSENT_DEFAULT: z.string().default(''),
}).refine((c) => c.SPOOL_RESUME_PENDING < c.SPOOL_MAX_PENDING, {
  message: 'SPOOL_RESUME_PENDING must be < SPOOL_MAX_PENDING (hysteresis deadband)',
  path: ['SPOOL_RESUME_PENDING'],
});

export type CollectorEnv = z.infer<typeof CollectorEnvSchema>;

/** Memoized + frozen loader for the collector service config (parsed once per process). */
export const loadCollectorConfig = defineConfig(CollectorEnvSchema);
