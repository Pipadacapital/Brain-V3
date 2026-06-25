-- ops_ml_prediction_log.sql — the OPERATIONAL model-inference log (StarRocks append-only, brain_ops).
--
-- BRAIN V4 PHASE 5 RELOCATION (audit ML-home decision): this is the SAME table that previously lived in
-- the dbt-built brain_gold database (db/starrocks/gold_ml_prediction_log.sql → brain_gold.gold_ml_prediction_log).
-- brain_gold is being RETIRED in Phase 6 (the dbt internal Gold database is replaced by the V4 serving DB
-- brain_serving / mv_*). The ML inference log is NOT a dbt-derived Gold mart — it is an APPLICATION-WRITTEN
-- operational fact stream (the serving path appends each served prediction directly). Its V4 home is the
-- new operational StarRocks database brain_ops, alongside the other app-owned operational StarRocks state.
-- Moving it here removes the last dependence on brain_gold for the ML log so brain_gold can be retired.
--
-- The table is moved VERBATIM (identical DUPLICATE-KEY / RANGE-dynamic-partition model) — only the
-- database changes (brain_gold → brain_ops) and the table name (gold_ml_prediction_log →
-- ops_ml_prediction_log, dropping the now-misleading "gold_" prefix for an operational, non-Gold table).
--
-- APPEND-ONLY DUPLICATE-KEY model (mirrors silver_touchpoint / a Bronze stream): every served prediction
-- is an immutable fact — we never UPDATE/DELETE a logged inference. The deterministic prediction_id is the
-- replay-idempotency key (the serving writer pre-filters existing ids → INSERT-new-only, preserving the
-- PG INSERT...RETURNING append semantics). RANGE-partitioned on created_at (event time) with
-- dynamic_partition (create-ahead + 400d TTL), brand_id-leading key + HASH distribution.
--
-- Per-brand isolation: StarRocks has no RLS — isolation is by EXPLICIT brand_id scoping on every
-- read/write (the writer carries brandId; any future dashboard read goes through the metric-engine seam,
-- I-ST01), exactly like the prior brain_gold home. Money is not stored here (the prediction payload is
-- jsonb-as-text; any minor-unit fields inside it remain signed-BIGINT STRINGS, never float).
--
-- Idempotent DDL (CREATE TABLE IF NOT EXISTS) — applied by db/starrocks/ops/run_ops.sh + the live tests.

CREATE DATABASE IF NOT EXISTS brain_ops;

CREATE TABLE IF NOT EXISTS brain_ops.ops_ml_prediction_log (
  brand_id      VARCHAR(64)  NOT NULL,
  created_at    DATETIME     NOT NULL,            -- inference event time (partition key + key tail)
  prediction_id VARCHAR(128) NOT NULL,            -- deterministic id (replay-idempotency key)
  model_id      VARCHAR(128) NULL,                -- ml.model_registry model_id, or NULL if none registered
  subject_type  VARCHAR(64)  NOT NULL,            -- e.g. 'customer'
  subject_key   VARCHAR(128) NOT NULL,            -- e.g. brain_id
  prediction    VARCHAR(65533) NULL,              -- the served payload (scores/bands/etc.) as JSON text
  score         DOUBLE       NULL                 -- optional scalar for quick monitoring
)
ENGINE=OLAP
DUPLICATE KEY(brand_id, created_at, prediction_id)  -- partition col in the key (append-only fact)
PARTITION BY RANGE (created_at) ()                  -- empty () → dynamic_partition manages partitions
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
ORDER BY (brand_id, subject_type, subject_key)
PROPERTIES (
  "replication_num"                         = "3",   -- prod: 3; dev applier rewrites to 1
  "compression"                             = "LZ4",
  "dynamic_partition.enable"                = "true",
  "dynamic_partition.time_unit"             = "DAY",
  "dynamic_partition.start"                 = "-400",
  "dynamic_partition.end"                   = "7",
  "dynamic_partition.prefix"                = "p",
  "dynamic_partition.buckets"               = "8",
  "dynamic_partition.history_partition_num" = "0"
);
