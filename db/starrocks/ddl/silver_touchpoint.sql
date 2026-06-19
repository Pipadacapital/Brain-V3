-- silver_touchpoint — Silver journey-touchpoint mart (StarRocks brain_silver).
--
-- One row per (brand_id, brain_anon_id, touch_seq) — every SDK touch in journey order, with
-- first/last-touch flags, the deterministic channel ladder, UTM + click-ids, and the read-back
-- stitched_brain_id (the order's brain_id when the journey deterministically stitched to an order).
-- Read by the metric engine (journey reads) and the attribution credit writer. NO money column
-- (touchpoints are not monetary). Versioned DDL, applied by the starrocks-rebuild Argo job; dbt
-- full-refresh repopulates from Bronze SDK events.
CREATE DATABASE IF NOT EXISTS brain_silver;

CREATE TABLE IF NOT EXISTS brain_silver.silver_touchpoint (
  brand_id          VARCHAR(64)  NOT NULL,
  brain_anon_id     VARCHAR(128) NOT NULL,
  touch_seq         INT          NOT NULL,
  is_first_touch    BOOLEAN      NULL,   -- touch_seq = 1
  is_last_touch     BOOLEAN      NULL,   -- the journey's last touch
  channel           VARCHAR(64)  NULL,   -- paid_*/paid/email/organic_social/referral/direct (deterministic)
  utm_campaign      VARCHAR(255) NULL,
  utm_medium        VARCHAR(255) NULL,
  fbclid            VARCHAR(255) NULL,
  gclid             VARCHAR(255) NULL,
  ttclid            VARCHAR(255) NULL,
  occurred_at       DATETIME     NULL,   -- touch event time (the journey reads' date filter)
  stitched_brain_id VARCHAR(64)  NULL    -- the order's brain_id iff this journey stitched (else NULL)
)
ENGINE=OLAP
DUPLICATE KEY(brand_id, brain_anon_id, touch_seq)
DISTRIBUTED BY HASH(brand_id) BUCKETS 4
PROPERTIES ("replication_num" = "1");
