-- ops_scoped_recompute_request.sql — durable queue of scoped Gold-recompute requests.
--
-- Produced by IdentityChangeRecomputeConsumer when an identity.merged or identity.suppressed
-- event is consumed off the Kafka identity lane. The consumer writes a row per identity change;
-- a scheduled Spark job (not yet wired) consumes rows from this table to perform the
-- scoped per-brain_id partition-overwrite on the customer-grained Gold marts:
--   gold_customer_360, gold_customer_scores, gold_customer_segments, gold_cohorts,
--   gold_customer_health, gold_journey, gold_recommendation_features, gold_ai_features,
--   gold_attribution_credit, gold_attribution_paths, gold_marketing_attribution.
--
-- TENANT ISOLATION (V4 invariant): brand_id is the PRIMARY KEY lead column and the
-- DISTRIBUTED BY hash key — every row, read, and write is brand-scoped. A Spark job
-- MUST filter by brand_id before reading rows from this table.
--
-- IDEMPOTENCY: request_id is a deterministic UUID keyed on (brand_id, source_event_id).
-- Re-delivering the same Kafka message → same request_id → the StarRocks PRIMARY KEY
-- table's INSERT == upsert semantics make the write a no-op on retry.
--
-- MONEY: no money in this table. brain_ids and mart names are opaque identifiers, not
-- monetary quantities. NEVER add a money column here.
--
-- APPLIED BY: db/starrocks/ops/run_ops.sh (CREATE ... IF NOT EXISTS, idempotent).

CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.scoped_recompute_request (
  -- ── Tenant key (V4 invariant: brand_id MUST be the PK lead column + distribution key)
  brand_id         varchar(64)    NOT NULL,
  -- ── Idempotency key: deterministicUuid(brand_id || 'scoped-recompute' || source_event_id)
  request_id       varchar(64)    NOT NULL,
  -- ── Audit / causation
  source_event_id  varchar(64),               -- the identity event_id that triggered this request
  trigger_event    varchar(64),               -- 'identity.merged' | 'identity.suppressed'
  -- ── Affected scope (JSON arrays — never raw PII; brain_ids are opaque UUIDs)
  brain_ids        varchar(512),              -- JSON array of affected brain_id UUIDs (sorted)
  affected_marts   varchar(2048),             -- JSON array of Gold mart names
  -- ── Lifecycle timestamps
  requested_at     datetime,                  -- when the consumer wrote this row
  processed_at     datetime                   -- null until a Spark scoped-recompute job claims it
)
PRIMARY KEY (brand_id, request_id)
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
PROPERTIES (
  "replication_num"            = "1",
  "enable_persistent_index"    = "true"
);
