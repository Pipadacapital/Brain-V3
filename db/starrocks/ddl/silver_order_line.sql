-- silver_order_line — Silver order LINE-ITEM mart (StarRocks brain_silver).
-- feat-shopify-order-depth (Silver line-grain).
--
-- One row per (brand_id, order_id, line_index): the line items of each order's LATEST state
-- (the shim view bronze_order_line_src picks the newest order.* event and unnests its
-- line_items). Money is BIGINT minor units (I-S07). brand_id is the tenant key; per-brand
-- isolation is enforced at the Silver READ seam (I-ST01), NOT in dbt (ETL-writer posture).
-- Versioned DDL, applied by the starrocks-rebuild job; dbt full-refresh repopulates from Bronze.
--
-- H3 (audit): RANGE-partitioned on occurred_at (event time) with dynamic_partition (create-ahead +
-- 400d TTL); BUCKETS raised to 8; replication_num=3 for prod (dev applier rewrites to 1). The
-- partition column is carried into the PRIMARY KEY (StarRocks requires the partition col in the key).
CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_order_line (
  brand_id            VARCHAR(64)  NOT NULL,
  order_id            VARCHAR(128) NOT NULL,
  line_index          INT          NOT NULL,   -- 1-based ordinal within the order's line_items
  occurred_at         DATETIME     NOT NULL,   -- event time of the order's latest state (partition key)
  sku                 VARCHAR(256) NULL,
  title               VARCHAR(512) NULL,
  quantity            BIGINT       NULL,
  unit_price_minor    BIGINT       NULL,        -- per-unit, minor units (I-S07)
  line_total_minor    BIGINT       NULL,        -- qty * unit - line discount, minor units (I-S07)
  line_discount_minor BIGINT       NULL,        -- minor units (I-S07)
  product_id          VARCHAR(64)  NULL,
  variant_id          VARCHAR(64)  NULL,
  currency_code       CHAR(3)      NULL
)
ENGINE=OLAP
PRIMARY KEY(brand_id, order_id, line_index, occurred_at)  -- latest-state line grain; partition col in PK
PARTITION BY RANGE (occurred_at) ()                        -- empty () → dynamic_partition manages partitions
DISTRIBUTED BY HASH(brand_id, order_id) BUCKETS 8
ORDER BY (brand_id, order_id, line_index)
PROPERTIES (
  "replication_num"                         = "3",   -- prod: 3; dev applier rewrites to 1
  "enable_persistent_index"                 = "true",
  "compression"                             = "LZ4",
  "dynamic_partition.enable"                = "true",
  "dynamic_partition.time_unit"             = "DAY",
  "dynamic_partition.start"                 = "-400",
  "dynamic_partition.end"                   = "7",
  "dynamic_partition.prefix"                = "p",
  "dynamic_partition.buckets"               = "8",
  "dynamic_partition.history_partition_num" = "0"
);
