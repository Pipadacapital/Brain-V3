-- silver_order_state — Silver order-lifecycle mart (StarRocks brain_silver).
--
-- One row per (brand_id, order_id) at its LATEST lifecycle_state (the dbt mart is additive; this is
-- the upsert-to-latest projection). Read by the metric engine (order-status-mix). Money is BIGINT
-- minor units (I-S07); brand_id is the tenant key (per-brand row policy in managed StarRocks, the
-- app-level @brain_current_brand_id predicate in dev). Versioned DDL, applied by the
-- starrocks-rebuild Argo job (doc 08 §F.2 / doc 05). dbt full-refresh repopulates from Bronze.
--
-- H3 (audit): RANGE-partitioned on state_effective_at (event time) with dynamic_partition (create-ahead
-- + 400d TTL); BUCKETS raised to 8; replication_num=3 for prod (dev applier rewrites to 1). The
-- partition column is carried into the PRIMARY KEY (StarRocks requires the partition col in the key).
CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_order_state (
  brand_id           VARCHAR(64)  NOT NULL,
  order_id           VARCHAR(128) NOT NULL,
  state_effective_at DATETIME     NOT NULL,  -- economic time of the latest state (partition + read filter)
  lifecycle_state    VARCHAR(32)  NULL,   -- placed|confirmed|shipped|in_transit|delivered|rto|cancelled|refunded
  order_value_minor  BIGINT       NULL,   -- gross order value, minor units (I-S07)
  currency_code      CHAR(3)      NULL,
  occurred_at        DATETIME     NULL    -- event time of the latest transition
)
ENGINE=OLAP
PRIMARY KEY(brand_id, order_id, state_effective_at)  -- latest-state-wins upsert; partition col in PK
PARTITION BY RANGE (state_effective_at) ()           -- empty () → dynamic_partition manages partitions
DISTRIBUTED BY HASH(brand_id, order_id) BUCKETS 8
ORDER BY (brand_id, order_id)
PROPERTIES (
  "replication_num"                         = "3",   -- prod: 3; dev applier rewrites to 1
  "enable_persistent_index"                 = "true",
  "compression"                             = "LZ4",
  "dynamic_partition.enable"                = "true",
  "dynamic_partition.time_unit"             = "DAY",
  "dynamic_partition.start"                 = "-400", -- TTL: drop partitions older than 400 days
  "dynamic_partition.end"                   = "7",    -- create 7 days of partitions ahead
  "dynamic_partition.prefix"                = "p",
  "dynamic_partition.buckets"               = "8",
  "dynamic_partition.history_partition_num" = "0"
);
