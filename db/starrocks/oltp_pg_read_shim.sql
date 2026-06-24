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

-- MEDALLION REALIGNMENT (Epic 1 / decision B): silver_order_ledger_src (the read-shim over the PG
-- realized_revenue_ledger) was REMOVED with migration 0098. Silver now builds the recognition ledger
-- from Bronze (stg_order_events_bronze → silver_order_recognition → brain_gold.gold_revenue_ledger);
-- there is no PG revenue ledger to shim. The brand_horizons_src + identity_link_src shims (used by
-- silver_order_recognition for recognition horizons + identity resolution) remain below.

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

-- MEDALLION REALIGNMENT (Epic 2): gold_attribution_credit_src (the read-shim over the PG
-- attribution_credit_ledger) was REMOVED with migration 0099. The attribution credit ledger is now
-- the app-written StarRocks table brain_gold.gold_attribution_credit; gold_marketing_attribution is a
-- dbt VIEW over it (no PG, no Spark materialize, no shim).

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
-- MEDALLION REALIGNMENT (Epic 4): connector_journey_stitch_map_src (the PG JDBC read-shim) was REMOVED.
-- The cart-stitch is materialized into brain_silver.silver_journey_stitch by the journey-stitch-export
-- job; silver_touchpoint reads that StarRocks projection directly (no PG analytical read).

-- ── Medallion realignment (Epic 1): shims for Silver recognition-from-Bronze ───────────────────
-- brand recognition horizons (operational config — legitimately PG) for finalization.
CREATE OR REPLACE VIEW brand_horizons_src AS
SELECT id::text AS brand_id,
       cod_recognition_horizon_days,
       prepaid_recognition_horizon_days
FROM tenancy.brand;
GRANT SELECT ON brand_horizons_src TO brain;

-- MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity_link_src (the PG identity_link JDBC shim) was
-- REMOVED. Identity is the Neo4j SoR; the identity-export job materializes the active hash→brain_id
-- edges into brain_silver.silver_identity_link (StarRocks), which silver_order_recognition reads
-- directly. There is no PG identity table to shim.
