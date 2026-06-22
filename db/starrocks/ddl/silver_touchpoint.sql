-- silver_touchpoint — Silver journey-touchpoint mart (StarRocks brain_silver).
--
-- One row per (brand_id, brain_anon_id, touch_seq) — every SDK touch in journey order, with
-- first/last-touch flags, the deterministic channel ladder, UTM + click-ids, page/commerce-intent
-- fields, and the read-back stitched_brain_id (the order's brain_id when the journey deterministically
-- stitched to an order). Read by the metric engine (journey/funnel/engagement reads) and the
-- attribution credit writer. NO money column (touchpoints are not monetary). Versioned DDL, applied by
-- the starrocks-rebuild Argo job; dbt full-refresh repopulates from Bronze SDK events.
--
-- H3 (audit): RANGE-partitioned on occurred_at (event time) with dynamic_partition (create-ahead +
-- 400d TTL); BUCKETS raised to 8; replication_num=3 for prod (dev applier rewrites to 1). Partition
-- column carried as a leading DUPLICATE-KEY column (StarRocks requires the partition col in the key).
-- Columns aligned to the dbt mart (silver_touchpoint.sql) incl. the H6 behavioral event set.
CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_touchpoint (
  brand_id          VARCHAR(64)  NOT NULL,
  brain_anon_id     VARCHAR(128) NOT NULL,
  touch_seq         INT          NOT NULL,
  occurred_at       DATETIME     NOT NULL,  -- touch event time (partition key + the journey reads' date filter)
  session_key       BIGINT       NULL,
  session_seq       INT          NULL,
  is_first_touch    BOOLEAN      NULL,   -- touch_seq = 1
  is_last_touch     BOOLEAN      NULL,   -- the journey's last touch
  event_type        VARCHAR(64)  NULL,   -- page.viewed/product.viewed/.../cart.item_added/checkout.started/scroll.depth/element.clicked (H6)
  channel           VARCHAR(64)  NULL,   -- paid_*/paid/email/organic_social/referral/direct (deterministic)
  utm_source        VARCHAR(255) NULL,
  utm_medium        VARCHAR(255) NULL,
  utm_campaign      VARCHAR(255) NULL,
  utm_term          VARCHAR(255) NULL,
  utm_content       VARCHAR(255) NULL,
  fbclid            VARCHAR(255) NULL,
  gclid             VARCHAR(255) NULL,
  ttclid            VARCHAR(255) NULL,
  msclkid           VARCHAR(255) NULL,
  gbraid            VARCHAR(255) NULL,
  wbraid            VARCHAR(255) NULL,
  dclid             VARCHAR(255) NULL,
  referrer_host     VARCHAR(255) NULL,
  landing_path      VARCHAR(512) NULL,
  page_type         VARCHAR(64)  NULL,
  product_handle    VARCHAR(255) NULL,
  collection_handle VARCHAR(255) NULL,
  search_query      VARCHAR(512) NULL,
  stitched_order_id VARCHAR(128) NULL,
  stitched_brain_id VARCHAR(64)  NULL,   -- the order's brain_id iff this journey stitched (else NULL)
  is_synthetic      BOOLEAN      NULL,
  session_id_raw    VARCHAR(128) NULL,
  updated_at        DATETIME     NULL
)
ENGINE=OLAP
DUPLICATE KEY(brand_id, brain_anon_id, touch_seq, occurred_at)  -- partition col in the key
PARTITION BY RANGE (occurred_at) ()                              -- empty () → dynamic_partition manages partitions
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
ORDER BY (brand_id, brain_anon_id, touch_seq)
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
