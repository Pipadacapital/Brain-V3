/**
 * @brain/config — stream-worker service configuration.
 *
 * Typed single-source-of-record for every configurable value the stream-worker
 * service reads from the environment. Each field mirrors a `process.env[...]`
 * read in apps/stream-worker/src with its EXACT prior default + coercion, so
 * repointing reads to this object is a pure refactor (zero behavior change).
 *
 * Intentionally LEFT RAW in the service (NOT modeled here):
 *  - NODE_ENV / APP_ENV gating that runs before config loads or selects the
 *    Kafka topic prefix.
 *  - Dynamic env keys (e.g. process.env[def.groupIdEnv] in bronzeBridges — the
 *    var name is computed from a registry, not a fixed identifier).
 *  - Secret/credential resolution that branches on prod and reads vendor secret
 *    ARNs/IDs/tokens (Shopify/Meta/Google/Razorpay/Shiprocket/GoKwik/Woo creds,
 *    AWS region + KMS key ids, *_ACCESS_TOKEN, *_CLIENT_SECRET). These are
 *    handled by the per-brand secret vault / prod secret-resolution paths.
 */
import { z } from 'zod';
import { CommonEnvSchema, defineConfig } from './common.js';

/**
 * Strict ==='true' boolean coerce (NOT z.coerce.boolean, which treats any
 * non-empty string as true). Mirrors `process.env['X'] === 'true'`.
 */
const strictTrue = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === 'true'));

/** Strict ==='1' boolean coerce. Mirrors `process.env['X'] === '1'`. */
const strictOne = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : v === '1'));

// ── Stream-worker env vars ────────────────────────────────────────────────────

export const StreamWorkerEnvSchema = CommonEnvSchema.extend({
  // Self-satisfying so the memoized loader validates even when SERVICE_NAME is unset (the common
  // case — it is rarely injected per-service in dev). default() fills the literal when env omits it.
  SERVICE_NAME: z.literal('stream-worker').default('stream-worker'),

  // ── Core infra ──────────────────────────────────────────────────────────────
  /** Kafka broker list (comma-split). main.ts + every repull/backfill job. */
  KAFKA_BROKERS: z.string().default('localhost:9092'),
  /** Redis connection URL. main.ts + feature-materialization. */
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /**
   * Worker DB connection — MUST be brain_app (RLS enforced). main.ts + most jobs
   * read BRAIN_APP_DATABASE_URL with this default; a few jobs fall back to
   * DATABASE_URL before defaulting (kept raw in those jobs — see notes).
   */
  BRAIN_APP_DATABASE_URL: z
    .string()
    .default('postgres://brain_app:brain_app@localhost:5432/brain'),

  // ── Live lane: topic + consumer groups (main.ts) ─────────────────────────────
  /** Live collector topic the consumers subscribe to. */
  COLLECTOR_TOPIC: z.string().default('dev.collector.event.v1'),
  CONSUMER_GROUP_ID: z.string().default('stream-worker-live'),
  IDENTITY_CONSUMER_GROUP_ID: z.string().default('identity-bridge-live'),
  CONSENT_SUPPRESSOR_CONSUMER_GROUP_ID: z
    .string()
    .default('stream-worker-consent-suppressor'),
  CAPI_DELETION_CONSUMER_GROUP_ID: z.string().default('stream-worker-capi-deletion'),
  /**
   * Consumer group for the DPDP/PDPL crypto-shred erasure orchestrator. Reads the same
   * live collector topic as ConsentSuppressorConsumer / CapiDeletionConsumer — separate
   * group, no new topic, no new deployable (I-E05). Runs the ordered 6-step shred sequence.
   */
  ERASURE_ORCHESTRATOR_CONSUMER_GROUP_ID: z
    .string()
    .default('stream-worker-erasure-orchestrator'),
  LIVE_LEDGER_CONSUMER_GROUP_ID: z.string().default('live-ledger-bridge'),
  SETTLEMENT_LEDGER_CONSUMER_GROUP_ID: z.string().default('settlement-ledger-bridge'),
  // RETIRED (0117): GOKWIK_AWB_LEDGER_CONSUMER_GROUP_ID — the GoKwik AWB logistics model is gone
  // (webhook-first payments/checkout; logistics truth is Shiprocket).
  /** Consumer group for identity-change → scoped-Gold-recompute pipeline (V4). */
  IDENTITY_CHANGE_RECOMPUTE_CONSUMER_GROUP_ID: z
    .string()
    .default('stream-worker-identity-recompute'),

  /**
   * Consumer group for the analytics cache-invalidation consumer — it consumes
   * cache.invalidate.v1 (emitted by the identity-recompute consumer) and evicts the
   * brand-scoped serving-cache keys so the serving tier never serves stale Gold.
   */
  ANALYTICS_CACHE_INVALIDATE_CONSUMER_GROUP_ID: z
    .string()
    .default('stream-worker-analytics-cache-invalidate'),

  /**
   * SPEC: A.2.3.5 (WA-18, AMD-08) — consumer group for the event-driven re-stitch dirty-set consumer.
   * It consumes the SAME identity.{minted,linked,merged,unmerged}.v1 lane under its OWN group (AMD-08 R1
   * unifies the map-mutation lane; separate offsets from the recompute consumer) and marks the affected
   * (brand_id, identifier_hash | brain_id) keys dirty in ops.restitch_pending so the Spark stitch job
   * re-evaluates PAST sessions within the attribution lookback. Per-brand gated by `stitch.v2` (DEFAULT
   * OFF): with no brand opted in it is an inert flag-check (nothing enqueued, byte-identical golden).
   */
  RESTITCH_DIRTY_CONSUMER_GROUP_ID: z
    .string()
    .default('stream-worker-restitch-dirty'),

  /**
   * SPEC: B.2 (WB-B2, AMD-08, AMD-11) — consumer group for the event-driven cross-device JOURNEY
   * re-version dirty-set consumer. It consumes the SAME identity.{linked,merged,unmerged}.v1 lane under
   * its OWN group (AMD-08 R1 unifies the map-mutation lane; separate offsets from the recompute + restitch
   * consumers) and marks the affected BRAIN_IDS dirty in ops.journey_reversion_pending so the Spark
   * reversion job rebuilds those brains' journeys as version N+1 + writes journey_version_log. Per-brand
   * gated by `journey.engine` (DEFAULT OFF): with no brand opted in it is an inert flag-check (nothing
   * enqueued, byte-identical golden journeys).
   */
  JOURNEY_REVERSION_DIRTY_CONSUMER_GROUP_ID: z
    .string()
    .default('stream-worker-journey-reversion-dirty'),

  // ── Real-time touchpoint cache (SPEC: A.4 / flag identity.tp_cache, default OFF) ──
  /**
   * Consumer group for the touchpoint-cache consumer. Reads the SAME live collector topic
   * (touchpoint content) AND the identity.merged.v1 lane (merge invalidation) under its OWN
   * group — no new topic, no new deployable (I-E05). Per-event gated by the per-brand
   * identity.tp_cache flag (default OFF): with no brand opted in it is an inert flag-check.
   */
  TP_CACHE_CONSUMER_GROUP_ID: z.string().default('stream-worker-tp-cache'),
  /** Max touchpoints retained per {brand}:tp:{brain} zset (A.4 = 200). */
  TP_CACHE_MAX_TOUCHPOINTS: z.coerce.number().int().positive().default(200),
  /** Sliding TTL (days) refreshed on every write (A.4 = 30d). */
  TP_CACHE_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // ── Backfill lane (main.ts) ──────────────────────────────────────────────────
  /**
   * Backfill topic. Default DERIVES from NODE_ENV (prod→'prod', else→'dev'); the
   * field below is optional and, when unset, the loader computes the derived
   * default — see the loader's post-parse step.
   */
  BACKFILL_TOPIC: z.string().optional(),
  BACKFILL_CONSUMER_GROUP_ID: z.string().default('stream-worker-backfill'),

  // ── Health / probes (main.ts) ────────────────────────────────────────────────
  // 8091 (NOT 8090): Trino maps host 8090 in docker-compose, so a local stream-worker health
  // server on 8090 collides (EADDRINUSE). k8s separates them, but keep dev clean too.
  HEALTH_PORT: z.coerce.number().int().default(8091),

  // ── Bronze write switch (main.ts) ────────────────────────────────────────────
  /** PG bronze_events write — RETIRED, default OFF (===' true' semantics). */
  BRONZE_PG_WRITE_ENABLED: strictTrue(false),

  // ── CAPI creds gate (main.ts) ────────────────────────────────────────────────
  META_CAPI_CREDS_WIRED: strictTrue(false),

  // ── In-process interval loops (main.ts) ──────────────────────────────────────
  SYNC_REQUEST_CLAIMER_INTERVAL_MS: z.coerce.number().int().default(5000),
  DQ_CHECK_INTERVAL_MS: z.coerce.number().int().default(300000),
  SYNC_SCHEDULER_INTERVAL_MS: z.coerce.number().int().default(45000),
  REPULL_CLAIM_BATCH: z.coerce.number().int().default(100),
  // In-worker drainer for queued jobs.backfill_job rows (the UI "Backfill" button enqueues them).
  // Mirrors the sync-request-claimer: without it, dev backfills sit 'queued' forever (prod runs a cron).
  BACKFILL_CLAIMER_INTERVAL_MS: z.coerce.number().int().default(60000),

  // ── duckdb-serving (Silver/Gold) readers — Brain V4 (Trino removed, ADR-0014) ─
  /**
   * Optional — when absent, the Silver-tier DQ checks + the journey-stitch / feature
   * materialization jobs degrade to honest no_data (the serving tier is the SOLE source).
   * Defaults to 'localhost' to MATCH the core config (packages/config/src/core.ts) — without a
   * default the journey-stitch-from-identity job (reads mv_silver_touchpoint over serving) silently
   * SKIPPED when the host was absent from the env file, starving stitches → attribution. The
   * serving tier is always present in dev/prod, so localhost is the correct default; override per env.
   */
  DUCKDB_SERVING_HOST: z.string().default('localhost'),
  /** duckdb-serving HTTP port (uvicorn :8091 — same port in-container and on the host). */
  DUCKDB_SERVING_PORT: z.coerce.number().int().default(8091),

  // ── Identity store (Neo4j) — main.ts + phone-guard + identity-export ─────────
  NEO4J_URI: z.string().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default('neo4j'),

  // ── Region (woocommerce + ingestion backfill) ───────────────────────────────
  BRAIN_REGION_CODE: z.string().default('IN'),

  // ── Partition-maintenance job ────────────────────────────────────────────────
  PARTITION_AHEAD_MONTHS: z.coerce.number().int().default(3),
  /** Optional — no default (job branches on undefined). */
  PARTITION_RETENTION_MONTHS: z.string().optional(),

  // ── ingest-dedup-prune job (ADR-0012) ────────────────────────────────────────
  /**
   * Retention window for data_plane.ingest_dedup, as a Postgres interval literal (e.g. '180 days').
   * Rows whose ingested_at is older than now() - this are pruned. Must stay >= the longest backfill
   * window so a re-ingest never re-presents a forgotten (brand_id, event_id). Default 180 days.
   */
  INGEST_DEDUP_RETAIN: z.string().default('180 days'),
  /** Batch size for the batched prune DELETE (bounds the lock per statement). */
  INGEST_DEDUP_PRUNE_BATCH: z.coerce.number().int().positive().default(50000),

  // ── Repull / backfill paging knobs ───────────────────────────────────────────
  /** shopify-backfill page sleep (ms). */
  BACKFILL_PAGE_SLEEP_MS: z.coerce.number().int().default(0),
  /** shopify-repull page sleep (ms). */
  REPULL_PAGE_SLEEP_MS: z.coerce.number().int().default(0),
  /** Optional — ingest-scheduler dispatch concurrency (job parses when present). */
  REPULL_DISPATCH_CONCURRENCY: z.string().optional(),
  /** Optional — woocommerce backfill window (days); job parses when present. */
  WOOCOMMERCE_BACKFILL_DAYS: z.string().optional(),
  /** Optional — ingestion-backfill target brand (job branches on undefined). */
  INGEST_BACKFILL_BRAND_ID: z.string().optional(),

  // ── Vendor client knobs (non-secret) ─────────────────────────────────────────
  /** Shopify Admin API version (shared across shopify clients/fetchers). */
  SHOPIFY_API_VERSION: z.string().optional(),
  /** meta-insights async mode ('1' → async). */
  META_INSIGHTS_ASYNC_MODE: strictOne(false),
  /** WooCommerce live-mode override ('1' → live, also true in prod). */
  WOOCOMMERCE_LIVE: strictOne(false),
  /** WooCommerce orders fixture path (dev). Optional — client defaults. */
  WOOCOMMERCE_FIXTURE_PATH: z.string().optional(),
  /** WooCommerce products fixture path (dev). Optional — fetcher defaults. */
  WOOCOMMERCE_PRODUCTS_FIXTURE_PATH: z.string().optional(),
  /** Shiprocket live-mode override ('1' → live, also true in prod). */
  SHIPROCKET_LIVE: strictOne(false),
  /** Shiprocket fixture path (dev). Optional — client defaults. */
  SHIPROCKET_FIXTURE_PATH: z.string().optional(),
  SHIPROCKET_BASE_URL: z.string().default('https://apiv2.shiprocket.in'),
  SHIPROCKET_SHIPMENTS_PATH: z.string().default('/v1/external/orders'),
  SHIPROCKET_SHIPMENTS_KEY: z.string().default('data'),
  /**
   * SR-7: per-AWB Shipment Tracking endpoint (DOCUMENTED, unlike the list path). Used for HISTORICAL
   * backfill of a single AWB's lifecycle when the list-window doesn't cover it. `{awb}` is substituted.
   * Default per Shiprocket docs: GET /v1/external/courier/track/awb/{awb}.
   */
  SHIPROCKET_TRACK_PATH: z.string().default('/v1/external/courier/track/awb/{awb}'),
  /** GoKwik AWB fixture path (dev). Optional — client defaults. */
  GOKWIK_AWB_FIXTURE_PATH: z.string().optional(),

  // ── identity-export job flag ─────────────────────────────────────────────────
  /** Full refresh ('1' → full). */
  IDENTITY_EXPORT_FULL: strictOne(false),

  // ── Argo Workflows submit (Bronze raw-PII erasure — AUD-OPS-037) ─────────────
  /**
   * Base URL the erasure orchestrator submits the `bronze-raw-erasure` WorkflowTemplate
   * against. UNSET (default — dev/tests) → the Bronze-raw erasure step stays the
   * registered-DISABLED shredIcebergSnapshots seam (honest no-op, never a silent success).
   * Prod (k8s mode): https://kubernetes.default.svc — the argo-workflows app is
   * controller-only (no REST server), so submit = a k8s-API Workflow create.
   */
  ARGO_SERVER_URL: z.string().optional(),
  /**
   * 'k8s' (default) = create a Workflow CR with workflowTemplateRef via the Kubernetes API
   * (projected SA token + cluster CA). 'argo-server' = POST the Argo server's
   * /api/v1/workflows/{ns}/submit (requires the server to be enabled; Bearer = ARGO_TOKEN).
   */
  ARGO_SUBMIT_MODE: z.enum(['k8s', 'argo-server']).default('k8s'),
  /** Namespace the WorkflowTemplate lives in (the cronworkflows chart's destination). */
  ARGO_WORKFLOWS_NAMESPACE: z.string().default('argo'),
  /** WorkflowTemplate name (infra/helm/cronworkflows/templates/spark-erasure.yaml). */
  ARGO_ERASURE_WORKFLOW_TEMPLATE: z.string().default('bronze-raw-erasure'),
  /** Optional static bearer token (argo-server mode / out-of-cluster dev). */
  ARGO_TOKEN: z.string().optional(),
  /** Whole-request submit timeout (ms). */
  ARGO_SUBMIT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
});

export type StreamWorkerEnv = z.infer<typeof StreamWorkerEnvSchema>;

/** Loader return type: BACKFILL_TOPIC is always resolved (NODE_ENV-derived). */
export type StreamWorkerConfig = Omit<StreamWorkerEnv, 'BACKFILL_TOPIC'> & {
  BACKFILL_TOPIC: string;
};

/**
 * Memoized + frozen loader for the stream-worker config (parsed once per process).
 *
 * Post-parse: BACKFILL_TOPIC derives its default from NODE_ENV when unset
 * (mirrors `process.env['BACKFILL_TOPIC'] ?? \`${prod?'prod':'dev'}.collector.order.backfill.v1\``).
 */
const baseLoad = defineConfig(StreamWorkerEnvSchema);
let derived: StreamWorkerConfig | undefined;
export const loadStreamWorkerConfig = (): StreamWorkerConfig => {
  if (derived) return derived;
  const cfg = baseLoad();
  const envPrefix = cfg.NODE_ENV === 'production' ? 'prod' : 'dev';
  derived = Object.freeze({
    ...cfg,
    BACKFILL_TOPIC:
      cfg.BACKFILL_TOPIC ?? `${envPrefix}.collector.order.backfill.v1`,
  });
  return derived;
};
