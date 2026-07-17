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
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_SASL_USERNAME: z.string().optional(),
  KAFKA_SASL_PASSWORD: z.string().optional(),
  APICURIO_REGISTRY_URL: z.string().url().optional(),
  /** Rate limit: max events per brand per minute. */
  RATE_LIMIT_EVENTS_PER_MINUTE: z.coerce.number().int().min(1).default(10_000),

  // ── Direct-to-log ingest (ADR-0015 WS1) ──────────────────────────────────────
  /**
   * Kill switch for the direct-to-log accept path. DEFAULT TRUE — deviation from doc 18's
   * staged default-off, owner-approved (dummy data; the whole re-architecture ships as one
   * PR). The spool path is DELETED, so `false` REFUSES BOOT (main.ts) rather than silently
   * losing events — rollback of the architecture is a git revert, not a flag flip.
   * Strict ==='false' semantics (any other value, incl. unset, is true).
   */
  INGEST_DIRECT_TO_LOG: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
  /** Directory for the bounded local-disk fallback WAL (produce-failure durability anchor). */
  INGEST_FALLBACK_DIR: z.string().default('/tmp/collector-fallback'),
  /** Size cap (bytes) across the fallback WAL files; at cap + log down → 503 backpressure. Default 256 MiB. */
  INGEST_FALLBACK_MAX_BYTES: z.coerce.number().int().min(1).default(268_435_456),
  /** Background WAL flusher cadence (ms) — retries produce on reconnect, truncates flushed entries. */
  INGEST_FALLBACK_FLUSH_INTERVAL_MS: z.coerce.number().int().min(100).default(5_000),
  /** Retry-After (seconds) returned on a 503 INGEST_BACKPRESSURE (log down AND WAL saturated). */
  INGEST_FALLBACK_RETRY_AFTER_SECONDS: z.coerce.number().int().min(1).default(5),

  // ── Apicurio ────────────────────────────────────────────────────────────────
  /**
   * Legacy fallback registry URL used only when APICURIO_REGISTRY_URL is unset
   * (`cfg.APICURIO_REGISTRY_URL ?? cfg.APICURIO_URL`). Default 'http://localhost:8080'.
   */
  APICURIO_URL: z.string().default('http://localhost:8080'),

  // ── Edge abuse protection (REC-9) ────────────────────────────────────────────
  /** Edge rate limit: max requests per install_token per window. */
  EDGE_RATE_MAX_PER_WINDOW: z.coerce.number().int().min(1).default(600),
  /** Edge rate limit window (ms). */
  EDGE_RATE_WINDOW_MS: z.coerce.number().int().min(1).default(60_000),
  /**
   * Comma-separated origin allowlist; empty string ⇒ no allowlist (all origins).
   * AUD-INFRA-025: an empty allowlist in production is LOUDLY warned at startup
   * (edgePostureWarnings) — set it to the known storefront origins in prod.
   */
  EDGE_ORIGIN_ALLOWLIST: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((o) => o.trim()).filter((o) => o.length > 0)),
  /**
   * install_token→brand_id binding posture on the ingest routes (AUD-INFRA-025).
   * 'enforce' (default): a body presenting BOTH a well-formed install_token AND brand_id whose
   *   pairing is not registered (leaked/forged token writing another brand's lane) is rejected
   *   403 TOKEN_BRAND_MISMATCH before the spool. Fail-open: incomplete pairs and PG outages
   *   ADMIT (accept-before-validate — infrastructure failure never drops events).
   * 'log': same checks; mismatches are logged + counted but ADMITTED (instant rollback posture).
   * 'off': kill switch — no oracle lookups.
   */
  EDGE_TOKEN_BINDING_MODE: z.enum(['off', 'log', 'enforce']).default('enforce'),
  /** TTL (ms) of the in-process token→brand binding verdict cache. */
  EDGE_TOKEN_BINDING_TTL_MS: z.coerce.number().int().min(1_000).default(60_000),

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
});

export type CollectorEnv = z.infer<typeof CollectorEnvSchema>;

/** Memoized + frozen loader for the collector service config (parsed once per process). */
export const loadCollectorConfig = defineConfig(CollectorEnvSchema);
