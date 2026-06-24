-- gold_attribution_credit.sql — the LAKEHOUSE attribution credit ledger (StarRocks PRIMARY KEY table).
--
-- MEDALLION REALIGNMENT (Epic 2 / decision A→B): attribution credit/clawback OUT of PostgreSQL. The
-- reconcile batch job (AttributionCreditWriter) computes the per-touch credit rows in TypeScript (the
-- metric-engine is the sole math layer — I-E03/E04: exact signed BIGINT minor units, deterministic
-- credit_id, Markov for data_driven) and writes them HERE — not to PG billing.attribution_credit_ledger
-- (dropped). This replaces the PG ledger + the Spark attribution_credit_materialize → Bronze hop + the
-- gold_attribution_credit_src JDBC read-shim. The dashboard mart gold_marketing_attribution is a dbt
-- VIEW over this table (live, no refresh lag).
--
-- PRIMARY KEY (brand_id, credit_id): the deterministic sha256 credit id. Re-writing the same credit_id
-- is idempotent (the writer pre-filters existing ids → INSERT-new-only, preserving ON-CONFLICT-DO-NOTHING
-- semantics — never overwrites a saved credit). credited_revenue_minor is SIGNED BIGINT (+credit /
-- -clawback; I-S07, never float). Per-brand isolation is enforced at the metric-engine read seam
-- (withSilverBrand / I-ST01) + by explicit brand_id scoping in the writer's reads (StarRocks has no RLS).
--
-- Idempotent DDL (CREATE TABLE IF NOT EXISTS) — applied by db/starrocks bootstrap + the live tests.

CREATE DATABASE IF NOT EXISTS brain_gold;

CREATE TABLE IF NOT EXISTS brain_gold.gold_attribution_credit (
  brand_id               varchar(64)  NOT NULL,
  credit_id              varchar(128) NOT NULL,
  order_id               varchar(128),
  brain_anon_id          varchar(128),
  touch_seq              int,
  channel                varchar(64),
  campaign_id            varchar(255),
  model_id               varchar(32),
  row_kind               varchar(16),
  weight_fraction        varchar(64),   -- exact fraction string (metric-engine weightFractionString)
  credited_revenue_minor bigint,        -- SIGNED minor units (+credit / -clawback)
  currency_code          varchar(8),
  reversed_of_credit_id  varchar(128),
  reversal_reason        varchar(32),
  realized_revenue_minor bigint,
  confidence_grade       varchar(8),
  attribution_confidence varchar(16),   -- numeric-as-string; the view casts to decimal(4,3)
  model_version          varchar(32),
  metric_snapshot_id     varchar(128),
  occurred_at            datetime,
  economic_effective_at  datetime,
  billing_posted_period  varchar(7),
  updated_at             datetime
)
PRIMARY KEY (brand_id, credit_id)
DISTRIBUTED BY HASH(brand_id) BUCKETS 8
PROPERTIES ("replication_num" = "1", "enable_persistent_index" = "true");
