-- ============================================================================
-- oltp_pg_read_shim.sql — Postgres read-shim view for the StarRocks JDBC catalog.
-- feat-silver-tier-order-state (Stage 3, @data-engineer). APPLIED TO POSTGRES (not StarRocks).
--
-- WHY: StarRocks' JDBC external catalog cannot read Postgres `uuid` columns
--      (they surface as UNKNOWN_TYPE and any SELECT/CAST on them errors:
--       "Datatype of external table column [brand_id] is not supported!").
--      `realized_revenue_ledger.brand_id` and `.brain_id` are uuid.
--
-- FIX (smallest reversible): a read-only Postgres VIEW that casts the uuid columns to
--      text. dbt's staging source reads THIS VIEW through the JDBC catalog instead of the
--      base table. No base-table change, no data migration, no RLS change.
--
-- ADDITIVE + REVERSIBLE: CREATE OR REPLACE VIEW; rollback = `DROP VIEW IF EXISTS
--      silver_order_ledger_src;`. This is a dev read-shim, NOT a node-pg-migrate migration
--      (no 0031 consumed) — it lives in the read-path setup alongside oltp_jdbc_catalog.sql
--      and is applied by `make silver-catalog`.
--
-- DEV BOUNDARY (honest): the view is owned by `brain` (superuser) and is RLS-agnostic —
--      it exposes ALL brands' rows (the JDBC catalog connects as `brain` and bypasses RLS
--      anyway). This is the intended ETL-writer posture; per-brand isolation is enforced at
--      the Silver READ seam (metric-engine, I-ST01), not here.
--
-- PROD SWAP: in prod the staging source reads the Iceberg Bronze catalog (where brand_id is
--      already a native string type) — this shim is dev/transition-only and disappears.
-- ============================================================================

CREATE OR REPLACE VIEW silver_order_ledger_src AS
SELECT
    brand_id::text              AS brand_id,
    order_id,
    brain_id::text              AS brain_id,
    event_type,
    amount_minor,
    currency_code,
    occurred_at,
    economic_effective_at,
    -- appended (Phase G): CREATE OR REPLACE VIEW requires new columns at the END
    ledger_event_id,
    fee_minor,
    recognition_label,
    billing_posted_period,
    -- appended (M3): ingestion time — drives the incremental restatement watermark in silver_order_state
    -- (any row ingested since the last run re-folds its order, so late/backdated events are never missed).
    created_at
-- Schema-qualified: this table was RANGE-partitioned via a twin-swap (migration 0073). An unqualified
-- name made CREATE OR REPLACE VIEW re-bind to the renamed *_legacy table; qualifying pins the view to
-- the canonical (partitioned) table so the shim always reads live data.
FROM billing.realized_revenue_ledger;

-- Make the view readable through the JDBC catalog connection user (superuser `brain`
-- already owns it; explicit grant kept for documentation / non-superuser dev parity).
GRANT SELECT ON silver_order_ledger_src TO brain;

-- ============================================================================
-- Phase G (marketing): read-shims for the ad-spend + attribution-credit ledgers.
-- Same posture as silver_order_ledger_src — cast the uuid brand_id → text so the JDBC
-- catalog can read it; cross-brand by construction (per-brand isolation at the Silver
-- READ seam, I-ST01). PROD swap reads Iceberg Bronze (native strings) → shims disappear.
-- ============================================================================

-- ad_spend_ledger → silver_marketing_spend (Silver entity). spend is BIGINT minor units.
CREATE OR REPLACE VIEW silver_marketing_spend_src AS
SELECT
    brand_id::text   AS brand_id,
    spend_event_id,
    platform,
    level,
    level_id,
    parent_id,
    campaign_id,
    campaign_name,
    stat_date,
    spend_minor,
    currency_code,
    impressions,
    clicks,
    account_timezone,
    occurred_at
-- Schema-qualified (partitioned via twin-swap migration 0074) — see the note on silver_order_ledger_src.
FROM billing.ad_spend_ledger;

GRANT SELECT ON silver_marketing_spend_src TO brain;

-- attribution_credit_ledger → gold_marketing_attribution (Gold mart). credited_revenue_minor
-- is SIGNED BIGINT (+credit / -clawback). brand_id is the only uuid column to cast.
CREATE OR REPLACE VIEW gold_attribution_credit_src AS
SELECT
    brand_id::text   AS brand_id,
    credit_id,
    order_id,
    brain_anon_id,
    touch_seq,
    channel,
    campaign_id,
    model_id,
    row_kind,
    credited_revenue_minor,
    currency_code,
    realized_revenue_minor,
    reversed_of_credit_id,
    confidence_grade,
    attribution_confidence,
    model_version,
    occurred_at,
    economic_effective_at,
    billing_posted_period
FROM attribution_credit_ledger;

GRANT SELECT ON gold_attribution_credit_src TO brain;

-- ============================================================================
-- DB-AUDIT H6: identity.customer read-shim → first_identified_at (acquisition time) into the
-- customer marts. Casts the uuid brand_id/brain_id/merged_into → text for the JDBC catalog. Exposes
-- first_identified_at (earliest strong-identifier attach) alongside created_at (node mint = first seen).
-- Cross-brand by construction (superuser JDBC read); per-brand isolation at the Silver READ seam.
-- ============================================================================
CREATE OR REPLACE VIEW silver_customer_identity_src AS
SELECT
    brand_id::text            AS brand_id,
    brain_id::text            AS brain_id,
    lifecycle_state,
    merged_into::text         AS merged_into,
    created_at                AS minted_at,
    first_identified_at
FROM identity.customer;

GRANT SELECT ON silver_customer_identity_src TO brain;

-- ============================================================================
-- Touchpoint/journey Iceberg flip (silver_touchpoint): the per-touch mart LEFT JOINs the journey
-- stitch map (connector_journey_stitch_map, migration 0031) to attach stitched_brain_id / order_id.
-- The touchpoint EVENTS now read raw Iceberg Bronze (stg_touchpoint_events, bronze_source=iceberg) —
-- bronze_touchpoint_src is RETIRED with bronze_events — but the stitch map is still PG, so it needs a
-- uuid→text shim for the JDBC catalog. Moved here (from the legacy bronze_touchpoint_src.sql) so the
-- standard `make silver-catalog` wiring creates it. SCHEMA-QUALIFIED to pin the view (avoids the
-- CREATE-OR-REPLACE rebind-to-legacy hazard).
-- ============================================================================
CREATE OR REPLACE VIEW connector_journey_stitch_map_src AS
SELECT
    brand_id::text   AS brand_id,
    order_id,
    stitched_anon_id,
    brain_id::text   AS brain_id,
    click_ids::text  AS click_ids,   -- jsonb→text (JDBC cannot read jsonb)
    utms::text       AS utms,        -- jsonb→text
    created_at
FROM connectors.connector_journey_stitch_map;

GRANT SELECT ON connector_journey_stitch_map_src TO brain;

-- ── Medallion realignment (Epic 1): shims for Silver recognition-from-Bronze ───────────────────
-- brand recognition horizons (operational config — legitimately PG) for finalization.
CREATE OR REPLACE VIEW brand_horizons_src AS
SELECT id::text AS brand_id,
       cod_recognition_horizon_days,
       prepaid_recognition_horizon_days
FROM tenancy.brand;
GRANT SELECT ON brand_horizons_src TO brain;

-- identity_link hash→brain_id (for resolving an order's brain_id from its pre_hashed_email).
-- NOTE: identity is PG today (ADR-0003); Epic 3 re-points this to the Neo4j graph — the join key
-- abstraction (order identity-hash → brain_id) is unchanged.
CREATE OR REPLACE VIEW identity_link_src AS
SELECT brand_id::text AS brand_id,
       identifier_type,
       identifier_value,
       brain_id::text AS brain_id,
       is_active
FROM identity.identity_link;
GRANT SELECT ON identity_link_src TO brain;
