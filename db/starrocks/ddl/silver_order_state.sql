-- silver_order_state — Silver order-lifecycle mart (StarRocks brain_silver).
--
-- One row per (brand_id, order_id) at its LATEST lifecycle_state (the dbt mart is additive; this is
-- the upsert-to-latest projection). Read by the metric engine (order-status-mix). Money is BIGINT
-- minor units (I-S07); brand_id is the tenant key (per-brand row policy in managed StarRocks, the
-- app-level @brain_current_brand_id predicate in dev). Versioned DDL, applied by the
-- starrocks-rebuild Argo job (doc 08 §F.2 / doc 05). dbt full-refresh repopulates from Bronze.
CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_order_state (
  brand_id           VARCHAR(64)  NOT NULL,
  order_id           VARCHAR(128) NOT NULL,
  lifecycle_state    VARCHAR(32)  NULL,   -- placed|confirmed|shipped|in_transit|delivered|rto|cancelled|refunded
  order_value_minor  BIGINT       NULL,   -- gross order value, minor units (I-S07)
  currency_code      CHAR(3)      NULL,
  state_effective_at DATETIME     NULL,   -- economic time of the latest state (the read's date filter)
  occurred_at        DATETIME     NULL    -- event time of the latest transition
)
ENGINE=OLAP
PRIMARY KEY(brand_id, order_id)            -- latest-state-wins upsert (1 row per order)
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
PROPERTIES ("replication_num" = "1");
