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
    billing_posted_period
FROM realized_revenue_ledger;

-- Make the view readable through the JDBC catalog connection user (superuser `brain`
-- already owns it; explicit grant kept for documentation / non-superuser dev parity).
GRANT SELECT ON silver_order_ledger_src TO brain;
