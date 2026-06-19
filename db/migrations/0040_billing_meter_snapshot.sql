-- ============================================================================
-- 0040_billing_meter_snapshot.sql
-- feat-billing-meter (P1) — the realized-GMV billing meter + sealed snapshot
-- ============================================================================
--
-- Brain charges %-of-realized-GMV (doc 10 §"first paying customer": the bill is on realized
-- GMV, NOT attribution — so it does not wait for the decision stack). A bill must be
-- REPRODUCIBLE FROM THE LEDGER forever, so it is computed from a SEALED, immutable snapshot of
-- realized GMV for a billing period — never recomputed live. This table is that seal: the
-- foundation the inspectable bill + GST invoice (follow-up slices) read from.
--
-- ONE sealed row per (brand_id, billing_period): the metered realized GMV as-of the period's
-- last day, taken via the realized_gmv_as_of() named seam (0018:176) — the SOLE as-of path
-- (D-3: NO ad-hoc SUM(amount_minor) in app code). Billing rides on realized_revenue_ledger
-- ONLY (provisional rows are excluded inside realized_gmv_as_of).
--
-- IMMUTABILITY (the heart): append-only by GRANT — brain_app gets SELECT + INSERT, NEVER
-- UPDATE/DELETE. Once a period is sealed it can never silently change; the meter command's
-- ON CONFLICT (brand_id, billing_period) DO NOTHING makes a re-seal a no-op. A correction is a
-- NEW period/row, never an edit (mirrors realized_revenue_ledger's append-only posture, D-2).
--
-- RLS: ENABLE + FORCE; two-arg fail-closed current_setting('app.current_brand_id', TRUE) — a
-- missing GUC returns NULL → 0 rows, never a cross-tenant leak (NN-1 CRITICAL).
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE IF NOT EXISTS — no ALTER/DROP of existing objects.
-- ROLLBACK: DROP TABLE IF EXISTS gmv_meter_snapshot.

CREATE TABLE IF NOT EXISTS gmv_meter_snapshot (
  brand_id           UUID        NOT NULL,            -- tenant key / RLS anchor (I-S01)
  billing_period     CHAR(7)     NOT NULL             -- 'YYYY-MM' (matches ledger.billing_posted_period, D-2)
                       CHECK (billing_period ~ '^\d{4}-\d{2}$'),
  currency_code      CHAR(3)     NOT NULL,            -- paired with metered_gmv_minor ALWAYS (I-S07)
  metered_gmv_minor  BIGINT      NOT NULL             -- realized GMV in minor units; NEVER NUMERIC/float (I-S07)
                       CHECK (metered_gmv_minor >= 0),
  as_of_date         DATE        NOT NULL,            -- inclusive as-of (period's last day) fed to realized_gmv_as_of()
  ledger_row_count   BIGINT      NOT NULL DEFAULT 0,  -- provenance: # realized rows behind the figure (audit/inspect)
  sealed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, billing_period)              -- ONE seal per brand per period (idempotency backstop)
);

-- ── 1. RLS: brand isolation, two-arg fail-closed (NN-1) ───────────────────────
ALTER TABLE gmv_meter_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmv_meter_snapshot FORCE ROW LEVEL SECURITY;

CREATE POLICY gmv_meter_snapshot_isolation ON gmv_meter_snapshot
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 2. Append-only by GRANT (immutable seal) — NO UPDATE / NO DELETE ──────────
-- brain_app gets SELECT + INSERT ONLY. Any UPDATE or DELETE attempt is a hard permission
-- error — a sealed period is physically un-editable through the app role.
REVOKE ALL ON gmv_meter_snapshot FROM brain_app;
GRANT SELECT, INSERT ON gmv_meter_snapshot TO brain_app;

-- ── 3. Migration-time assertions (belt-and-suspenders) ────────────────────────

-- Assertion-1: RLS is ENABLED + FORCED on the table.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE relname = 'gmv_meter_snapshot' AND relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'RLS GUARD (0040): gmv_meter_snapshot must have ROW LEVEL SECURITY ENABLED + FORCED.';
  END IF;
END
$$;

-- Assertion-2: the isolation policy uses the two-arg (fail-closed) current_setting (NN-1).
DO $$
DECLARE
  v_qual text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO v_qual
    FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
   WHERE c.relname = 'gmv_meter_snapshot' AND pol.polname = 'gmv_meter_snapshot_isolation';
  IF v_qual IS NULL THEN
    RAISE EXCEPTION 'RLS GUARD (0040): isolation policy not found on gmv_meter_snapshot.';
  END IF;
  -- must NOT be the one-arg form (which would ERROR on missing GUC instead of failing closed).
  IF v_qual LIKE '%current_setting(''app.current_brand_id'')%'
     AND v_qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%' THEN
    RAISE EXCEPTION 'RLS GUARD (0040): policy must use two-arg current_setting(..., TRUE) (NN-1 fail-closed).';
  END IF;
END
$$;

-- Assertion-3: append-only-by-GRANT — brain_app must NOT hold UPDATE or DELETE.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(privilege_type, ', ') INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_name = 'gmv_meter_snapshot' AND grantee = 'brain_app'
     AND privilege_type IN ('UPDATE', 'DELETE');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'APPEND-ONLY VIOLATION (0040): brain_app holds "%" on gmv_meter_snapshot. '
      'A sealed billing period must be immutable — SELECT + INSERT only.', v_bad;
  END IF;
END
$$;
