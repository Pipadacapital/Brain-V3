-- 0074_partition_ad_spend_ledger.sql
--
-- DB-AUDIT C4b — RANGE-partition the ad-spend fact billing.ad_spend_ledger (unbounded append-only:
-- one row per brand × platform × level × level_id × stat_date, forever). Same PROVEN twin-swap as 0072.
--
-- Cleanest possible case: stat_date (the click-date anchor) is ALREADY in the dedup UNIQUE key
-- (brand_id, platform, level, level_id, stat_date), so partitioning by RANGE(stat_date) needs NO writer
-- change to the dedup ON CONFLICT and NO new column. The PK (brand_id, spend_event_id) widens to include
-- stat_date (harmless — spend_event_id is deterministic from platform/level/stat_date; no PK ON CONFLICT
-- exists). Retention/archival becomes an O(1) partition DROP; spend reporting prunes by date.
--
-- Index names carry a `_p` suffix; the legacy table keeps the canonical names through the verify window.
-- DEPLOY: self-contained (copy+swap in one txn); node-pg-migrate wraps it, or apply with `psql -1`.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE billing.ad_spend_ledger_part (
  brand_id         uuid                     NOT NULL,
  spend_event_id   text                     NOT NULL,
  platform         text                     NOT NULL,
  level            text                     NOT NULL,
  level_id         text                     NOT NULL,
  parent_id        text,
  campaign_id      text,
  campaign_name    text,
  stat_date        date                     NOT NULL,
  spend_minor      bigint                   NOT NULL,
  currency_code    character(3)             NOT NULL,
  impressions      bigint,
  clicks           bigint,
  conversions_raw  jsonb,
  account_timezone text,
  raw_event_id     text                     NOT NULL,
  occurred_at      timestamptz              NOT NULL,
  created_at       timestamptz              NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, spend_event_id, stat_date),
  CONSTRAINT ad_spend_ledger_level_check
    CHECK (level = ANY (ARRAY['campaign','adset','ad','creative'])),
  CONSTRAINT ad_spend_ledger_platform_check
    CHECK (platform = ANY (ARRAY['meta','google_ads']))
) PARTITION BY RANGE (stat_date);

-- Date partitions (seed near-term months) + a DEFAULT so no row is ever rejected.
CREATE TABLE billing.ad_spend_ledger_p2026_05 PARTITION OF billing.ad_spend_ledger_part
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE billing.ad_spend_ledger_p2026_06 PARTITION OF billing.ad_spend_ledger_part
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE billing.ad_spend_ledger_p2026_07 PARTITION OF billing.ad_spend_ledger_part
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE billing.ad_spend_ledger_pdefault PARTITION OF billing.ad_spend_ledger_part DEFAULT;

-- ── 2. Copy existing data ────────────────────────────────────────────────────────────────────────
INSERT INTO billing.ad_spend_ledger_part (
  brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
  stat_date, spend_minor, currency_code, impressions, clicks, conversions_raw, account_timezone,
  raw_event_id, occurred_at, created_at)
SELECT
  brand_id, spend_event_id, platform, level, level_id, parent_id, campaign_id, campaign_name,
  stat_date, spend_minor, currency_code, impressions, clicks, conversions_raw, account_timezone,
  raw_event_id, occurred_at, created_at
FROM billing.ad_spend_ledger;

-- ── 3. Recreate indexes + RLS + grants on the twin ──────────────────────────────────────────────
-- Dedup arbiter (UNIQUE) — IDENTICAL columns to the original (stat_date already present); `_p` name.
CREATE UNIQUE INDEX ad_spend_ledger_dedup_key_p
  ON billing.ad_spend_ledger_part (brand_id, platform, level, level_id, stat_date);
-- Brand×date scan index.
CREATE INDEX ad_spend_ledger_brand_date_idx_p
  ON billing.ad_spend_ledger_part (brand_id, stat_date);

ALTER TABLE billing.ad_spend_ledger_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.ad_spend_ledger_part FORCE ROW LEVEL SECURITY;
CREATE POLICY ad_spend_ledger_isolation ON billing.ad_spend_ledger_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON billing.ad_spend_ledger_part FROM brain_app;
GRANT SELECT, INSERT ON billing.ad_spend_ledger_part TO brain_app;  -- append-only by grant

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE billing.ad_spend_ledger      RENAME TO ad_spend_ledger_legacy;
ALTER TABLE billing.ad_spend_ledger_part RENAME TO ad_spend_ledger;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'billing.ad_spend_ledger'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0074: ad_spend_ledger must be PARTITIONED after swap'; END IF;
  SELECT count(*) INTO legacy_n FROM billing.ad_spend_ledger_legacy;
  SELECT count(*) INTO new_n    FROM billing.ad_spend_ledger;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0074: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;
END $$;

-- billing.ad_spend_ledger_legacy is retained for a post-deploy verification window; DROP it in a
-- follow-up migration once the partitioned table is confirmed serving reads + writes.
