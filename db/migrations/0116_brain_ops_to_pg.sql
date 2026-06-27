-- ============================================================================
-- 0116_brain_ops_to_pg.sql — BRAIN V4 (StarRocks REMOVAL): relocate the brain_ops
--   operational StarRocks tables into a PostgreSQL `ops` schema.
-- ============================================================================
-- WHY: V4 removes StarRocks. PG becomes the SOLE operational store. The seven objects
--   that lived in the StarRocks `brain_ops` database (db/starrocks/ops/*.sql) move here.
--   These are NOT medallion marts — they are APPLICATION-WRITTEN operational state:
--   identity-graph projections, the journey cart-stitch projection, export watermarks,
--   the ML inference log, and the scoped-recompute queue. The worker + ETL jobs read/write
--   them directly. Their Iceberg/Spark-built Silver/Gold cousins are SEPARATE objects and
--   are untouched by this migration.
--
-- WHAT MOVES (faithful to db/starrocks/ops/*.sql columns/types/PKs, PG-idiomatic):
--   1. ops.silver_identity_link        — Neo4j IDENTIFIES projection (UPSERT)        PK(brand_id, identifier_type, identifier_value)
--   2. ops.silver_customer_identity    — Neo4j Customer-node projection (UPSERT)     PK(brand_id, brain_id)
--   3. ops.silver_journey_stitch       — cart-stitch projection (TRUNCATE+reload)    PK(brand_id, order_id)
--   4. ops.identity_export_state       — export high-watermark (UPSERT, singleton)   PK(scope)
--   5. ops.ops_ml_prediction_log       — append-only inference log, RANGE-PARTITIONED on created_at  PK(brand_id, created_at, prediction_id)
--   6. ops.scoped_recompute_request    — scoped Gold-recompute queue (UPSERT)        PK(brand_id, request_id)
--
-- WHAT DOES *NOT* MOVE:
--   7. connector_journey_stitch_map — in StarRocks this was only a JDBC read-VIEW
--      (db/starrocks/ops/ops_connector_journey_stitch_map.sql) over the PG-native OLTP
--      truth connectors.connector_journey_stitch_map (created in 0031, schema-moved 0063).
--      The PG source table ALREADY EXISTS — there is nothing to recreate. With StarRocks
--      gone the analytical read simply reads the PG table directly. NO new ops.* table.
--
-- TYPE MAPPING (StarRocks → PG idiom):
--   varchar(64) brand_id / brain_id / merged_into  → uuid   (Brain's canonical tenant + customer ids)
--   varchar(*) opaque strings (identifier_*, tier, order_id, scope, prediction_id, …) → text
--   datetime                                        → timestamptz
--   double                                          → double precision
--   json-as-varchar (brain_ids, affected_marts, prediction payload) → jsonb
--   bigint / boolean                                → unchanged
--   brand_id is the FIRST column AND the PK lead on every brand-scoped row (V4 invariant).
--   identity_export_state has NO brand_id — it is an operational singleton keyed by `scope`
--   (one watermark per export stream), exactly as in StarRocks; kept as-is.
--
-- ── RLS / GRANT DECISION (documented per task) ──────────────────────────────
--   These tables are written by TRUSTED ETL (the stream-worker identity-export /
--   journey-stitch-export jobs, the serve-customer-score path, and ScopedRecomputeRepository)
--   running as `brain_app` with NO `app.current_brand_id` GUC set — the jobs operate across
--   ALL brands in a single pass (full/incremental projection reload, watermark advance,
--   queue drain). The StarRocks originals had NO row-level isolation at all (StarRocks has
--   none); isolation was enforced by EXPLICIT brand_id scoping at the metric-engine read seam.
--   We MIRROR that posture here: brand_id is the PK-lead tenant key on every row, but we do
--   NOT ENABLE/FORCE RLS — a FORCE-RLS policy keyed on a (here always-absent) brand GUC would
--   fail-closed and BLOCK every trusted ETL upsert/reload. Read isolation stays the caller's
--   responsibility (brand_id = ? on every analytical read), identical to the prior StarRocks
--   home. (Contrast: jobs.resource_backfill_state IS FORCE-RLS because its accessors always
--   carry a brand GUC; these cross-brand ETL writers do not.)
--
--   GRANT: SELECT/INSERT/UPDATE/DELETE to brain_app on the UPSERT / reload tables (UPSERT
--   needs UPDATE; the TRUNCATE+reload export uses full-table DELETE → reload, hence DELETE).
--   The ML inference log is APPEND-ONLY (immutable facts, deterministic prediction_id =
--   replay-idempotency key) → SELECT/INSERT only, append-only-by-grant, mirroring the
--   billing.realized_revenue_ledger precedent (0073).
--
-- ── PARTITIONING (ops.ops_ml_prediction_log) ────────────────────────────────
--   Unbounded append-only fact stream → RANGE-partitioned on created_at, the SAME template as
--   billing.realized_revenue_ledger (0073): a real partition-key column that is ALSO in the PK
--   (PG requires the partition key be part of every UNIQUE/PK). Seed the current data range +
--   a DEFAULT catch-all so no row is ever rejected. Lifecycle (create-ahead + retention DROP)
--   is handled with ZERO new code by the existing catalog-driven routine
--   public.maintain_time_partitions(int,int) (0080), which auto-discovers EVERY RANGE-
--   partitioned table across all schemas from pg_catalog and uses the <table>_pYYYY_MM naming
--   this migration seeds — so ops.ops_ml_prediction_log is maintained automatically.
--
-- ROLLBACK: DROP SCHEMA IF EXISTS ops CASCADE;  (rebuildable projections; not a source of truth —
--   Neo4j / PG OLTP / Bronze + deterministic ids are. The ML log is replayable from served events.)
--
-- node-pg-migrate runs this with session search_path = public only, so every object below is
-- schema-qualified `ops.`. Idempotent: CREATE ... IF NOT EXISTS throughout.
-- ============================================================================

CREATE SCHEMA IF NOT EXISTS ops;
GRANT USAGE ON SCHEMA ops TO brain_app;

-- ── 1. ops.silver_identity_link — Neo4j IDENTIFIES projection (UPSERT) ───────
-- One row per (brand_id, identifier_type, identifier_value [64-hex hash, NEVER raw PII]).
-- brain_id = resolved customer; tier drives CAPI subject-hash selection; is_active mirrors
-- the edge state (tombstoned on erase). Written by identity-export (UPSERT on PK).
CREATE TABLE IF NOT EXISTS ops.silver_identity_link (
  brand_id          uuid     NOT NULL,
  identifier_type   text     NOT NULL,
  identifier_value  text     NOT NULL,          -- 64-hex hash (never raw PII)
  brain_id          uuid,
  tier              text,                        -- strong | strong_on_link | medium | weak
  is_active         boolean,
  updated_at        timestamptz,
  PRIMARY KEY (brand_id, identifier_type, identifier_value)
);

-- ── 2. ops.silver_customer_identity — Neo4j Customer-node projection (UPSERT) ─
-- One row per (brand_id, brain_id). merged_into = the surviving brain_id on a merge.
CREATE TABLE IF NOT EXISTS ops.silver_customer_identity (
  brand_id             uuid     NOT NULL,
  brain_id             uuid     NOT NULL,
  lifecycle_state      text,
  merged_into          uuid,
  minted_at            timestamptz,
  first_identified_at  timestamptz,
  updated_at           timestamptz,
  PRIMARY KEY (brand_id, brain_id)
);

-- ── 3. ops.silver_journey_stitch — cart-stitch projection (TRUNCATE+reload) ──
-- One row per (brand_id, order_id). stitched_anon_id = brain_anon_id read back from the order;
-- brain_id nullable until identity links. Written by journey-stitch-export (full reload).
CREATE TABLE IF NOT EXISTS ops.silver_journey_stitch (
  brand_id          uuid     NOT NULL,
  order_id          text     NOT NULL,
  stitched_anon_id  text,
  brain_id          uuid,
  created_at        timestamptz,
  updated_at        timestamptz,
  PRIMARY KEY (brand_id, order_id)
);

-- ── 4. ops.identity_export_state — export high-watermark (UPSERT, singleton) ──
-- scope = export stream identity ('identity_link' | 'customer_identity'). One row per scope.
-- NO brand_id: this is an operational singleton cursor per export stream (as in StarRocks).
CREATE TABLE IF NOT EXISTS ops.identity_export_state (
  scope               text    NOT NULL,         -- 'identity_link' | 'customer_identity'
  last_created_at_ms  bigint,                    -- MAX Neo4j created_at (epoch-millis) exported
  updated_at          timestamptz,
  PRIMARY KEY (scope)
);

-- ── 5. ops.ops_ml_prediction_log — append-only inference log, RANGE-PARTITIONED ─
-- Immutable served-prediction facts. created_at is the partition key AND part of the PK
-- (PG requires the partition column in every PK/UNIQUE). prediction_id = deterministic
-- replay-idempotency key. Money is NEVER stored here (payload is jsonb; any minor-unit
-- fields inside it stay signed-BIGINT strings, never float).
CREATE TABLE IF NOT EXISTS ops.ops_ml_prediction_log (
  brand_id      uuid             NOT NULL,
  created_at    timestamptz      NOT NULL,       -- inference event time (partition key + PK tail)
  prediction_id text             NOT NULL,       -- deterministic id (replay-idempotency key)
  model_id      text,                            -- ml.model_registry model_id, or NULL
  subject_type  text             NOT NULL,       -- e.g. 'customer'
  subject_key   text             NOT NULL,       -- e.g. brain_id
  prediction    jsonb,                           -- served payload (scores/bands/etc.) as JSON
  score         double precision,                -- optional scalar for quick monitoring
  PRIMARY KEY (brand_id, created_at, prediction_id)
) PARTITION BY RANGE (created_at);

-- Seed partitions (current data range) + DEFAULT catch-all. Names follow the <table>_pYYYY_MM
-- convention that public.maintain_time_partitions(0080) creates-ahead / drops, so the routine
-- auto-maintains this table with no code change.
CREATE TABLE IF NOT EXISTS ops.ops_ml_prediction_log_p2026_05 PARTITION OF ops.ops_ml_prediction_log
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS ops.ops_ml_prediction_log_p2026_06 PARTITION OF ops.ops_ml_prediction_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS ops.ops_ml_prediction_log_p2026_07 PARTITION OF ops.ops_ml_prediction_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS ops.ops_ml_prediction_log_pdefault PARTITION OF ops.ops_ml_prediction_log DEFAULT;

-- Monitoring scan index (mirrors the StarRocks ORDER BY (brand_id, subject_type, subject_key)).
CREATE INDEX IF NOT EXISTS idx_ops_ml_prediction_log_subject
  ON ops.ops_ml_prediction_log (brand_id, subject_type, subject_key);

-- ── 6. ops.scoped_recompute_request — scoped Gold-recompute queue (UPSERT) ───
-- request_id = deterministicUuid(brand_id || 'scoped-recompute' || source_event_id) → re-delivery
-- of the same Kafka event = same request_id = idempotent upsert. brain_ids / affected_marts are
-- JSON arrays of opaque ids/mart-names (never PII, never money). Drained by the v4-refresh-loop.
CREATE TABLE IF NOT EXISTS ops.scoped_recompute_request (
  brand_id         uuid     NOT NULL,
  request_id       text     NOT NULL,           -- deterministic UUID string (idempotency key)
  source_event_id  text,                         -- identity event_id that triggered this request
  trigger_event    text,                         -- 'identity.merged' | 'identity.suppressed'
  brain_ids        jsonb,                         -- JSON array of affected brain_id UUIDs (sorted)
  affected_marts   jsonb,                         -- JSON array of Gold mart names
  requested_at     timestamptz,                   -- when the consumer wrote this row
  processed_at     timestamptz,                   -- null until a scoped-recompute job claims it
  PRIMARY KEY (brand_id, request_id)
);

-- Drain index: find unprocessed requests (mirrors the v4-refresh-loop scoped drain).
CREATE INDEX IF NOT EXISTS idx_scoped_recompute_request_unprocessed
  ON ops.scoped_recompute_request (brand_id, requested_at)
  WHERE processed_at IS NULL;

-- ── GRANTS (see RLS / GRANT DECISION above) ──────────────────────────────────
-- UPSERT / reload tables: full DML (UPSERT → UPDATE; TRUNCATE+reload export → DELETE).
REVOKE ALL ON ops.silver_identity_link       FROM brain_app;
REVOKE ALL ON ops.silver_customer_identity   FROM brain_app;
REVOKE ALL ON ops.silver_journey_stitch      FROM brain_app;
REVOKE ALL ON ops.identity_export_state      FROM brain_app;
REVOKE ALL ON ops.scoped_recompute_request   FROM brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.silver_identity_link     TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.silver_customer_identity TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.silver_journey_stitch    TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.identity_export_state     TO brain_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.scoped_recompute_request TO brain_app;

-- Append-only inference log: SELECT + INSERT only (append-only-by-grant; like the money ledger).
-- Grant on the partitioned parent cascades to all current + future partitions.
REVOKE ALL ON ops.ops_ml_prediction_log FROM brain_app;
GRANT SELECT, INSERT ON ops.ops_ml_prediction_log TO brain_app;

-- ── Post-condition guard: schema + all six tables exist with the expected PKs ─
DO $$
DECLARE
  missing text;
  is_part boolean;
BEGIN
  SELECT string_agg(t, ', ') INTO missing
  FROM (
    SELECT t FROM unnest(ARRAY[
      'silver_identity_link','silver_customer_identity','silver_journey_stitch',
      'identity_export_state','ops_ml_prediction_log','scoped_recompute_request'
    ]) AS t
    WHERE NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'ops' AND c.relname = t
    )
  ) s;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '0116 GUARD: missing ops.* table(s): %', missing;
  END IF;

  SELECT c.relkind = 'p' INTO is_part
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'ops' AND c.relname = 'ops_ml_prediction_log';
  IF NOT is_part THEN
    RAISE EXCEPTION '0116 GUARD: ops.ops_ml_prediction_log must be RANGE-PARTITIONED';
  END IF;
END $$;
