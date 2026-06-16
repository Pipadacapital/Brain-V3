-- ============================================================================
-- 0018_realized_revenue_ledger.sql — Realized Revenue Ledger + brand config cols
-- feat-realized-revenue-ledger (Stage 3). Deterministic compute only — tier-0.
-- ============================================================================
-- MONEY invariants (I-S07):
--   • amount_minor + rounding_adjustment_minor are BIGINT — NEVER NUMERIC/float.
--   • currency_code CHAR(3) is ALWAYS paired with every money column.
--   • No UPDATE/DELETE on ledger rows by brain_app — append-only by GRANT.
--   • No PII — brain_id is a UUID reference, never raw contact detail.
--
-- Tenant isolation (I-S01):
--   • ENABLE + FORCE ROW LEVEL SECURITY on realized_revenue_ledger.
--   • Two-arg fail-closed: current_setting('app.current_brand_id', TRUE)
--     returns NULL on missing GUC → brand_id = NULL → FALSE → 0 rows.
--   • DO NOT use the one-arg form (raises exception on missing GUC — worse).
--
-- Append-only by GRANT (D-2):
--   • brain_app gets SELECT, INSERT ONLY — NO UPDATE, NO DELETE.
--   • Proven by migration-time assertion (§ assertion-2 below).
--
-- No-double-count (D-3):
--   • realized_gmv_as_of() excludes provisional_recognition rows.
--   • SOLE as-of read path — no ad-hoc SUM(amount_minor) in app.
--
-- Dedup (D-4):
--   • UNIQUE (brand_id, order_id, event_type, (occurred_at::date)).
--   • Writer uses ON CONFLICT DO NOTHING + replay-suppression metric.
--
-- Dual-date (D-2):
--   • occurred_at = event-time; economic_effective_at = economic-time.
--   • billing_posted_period CHAR(7) set from occurred_at in M1.
--   • Late reversal posts new current-period row — original rows never touched.
--
-- Single-currency-per-brand (D-6):
--   • BEFORE INSERT trigger rejects rows whose currency_code != brand.currency_code.
--
-- Banker's rounding (D-7):
--   • rounding_adjustment_minor BIGINT records the half-to-even delta.
--
-- ADDITIVE ONLY (I-E02): ALTER ADD COLUMN IF NOT EXISTS; CREATE TABLE IF NOT EXISTS.
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS realized_revenue_ledger;
--   DROP FUNCTION IF EXISTS realized_gmv_as_of(uuid, date);
--   DROP FUNCTION IF EXISTS ledger_currency_matches_brand();
--   ALTER TABLE brand DROP COLUMN IF EXISTS cod_recognition_horizon_days;
--   ALTER TABLE brand DROP COLUMN IF EXISTS prepaid_recognition_horizon_days;
--   ALTER TABLE brand DROP COLUMN IF EXISTS currency_code;
-- (Ledger is rebuildable from Bronze in M1 — DROP is safe, same as 0016.)
-- ============================================================================

-- ── 1. Brand column additions (D-1: horizons, D-6: currency) ─────────────────
-- Additive-safe: existing brand rows backfill to defaults (same as 0017 salt/threshold).
ALTER TABLE brand ADD COLUMN IF NOT EXISTS cod_recognition_horizon_days     INT     NOT NULL DEFAULT 25;
ALTER TABLE brand ADD COLUMN IF NOT EXISTS prepaid_recognition_horizon_days INT     NOT NULL DEFAULT 7;
ALTER TABLE brand ADD COLUMN IF NOT EXISTS currency_code                    CHAR(3) NOT NULL DEFAULT 'INR';

-- ── 2. realized_revenue_ledger table (doc-08 §7.1) ──────────────────────────
-- ONE ledger, event_type discriminator — NOT per-type tables (doc-08 §0.4 #1).
-- amount_minor: SIGNED BIGINT — positive for sales/finalization, negative for reversals.
-- rounding_adjustment_minor: BIGINT delta from banker's rounding (D-7); default 0.
CREATE TABLE IF NOT EXISTS realized_revenue_ledger (
  brand_id                    UUID        NOT NULL,           -- tenant key / RLS anchor (I-S01)
  ledger_event_id             TEXT        NOT NULL,           -- sha256(brand_id‖order_id‖event_type‖source_pk‖version)
  order_id                    TEXT        NOT NULL,
  brain_id                    UUID        NULL,               -- identity ref; never PII
  event_type                  TEXT        NOT NULL
                                CHECK (event_type IN (
                                  'provisional_recognition',
                                  'finalization',
                                  'rto_reversal',
                                  'refund',
                                  'chargeback',
                                  'cancellation',
                                  'settlement_fee_reversal',
                                  'marketplace_adjustment',
                                  'payment_adjustment',
                                  'concession'
                                )),
  amount_minor                BIGINT      NOT NULL,           -- SIGNED; reversals negative; NEVER NUMERIC/float (I-S07)
  currency_code               CHAR(3)     NOT NULL,           -- paired with amount_minor ALWAYS
  fx_rate_id                  UUID        NULL,               -- M1 single-currency → always NULL; no FK (no fx_rate table yet)
  rounding_adjustment_minor   BIGINT      NOT NULL DEFAULT 0, -- D-7 banker's-rounding delta; BIGINT (I-S07)
  occurred_at                 TIMESTAMPTZ NOT NULL,           -- event-time (dual-date #1)
  economic_effective_at       TIMESTAMPTZ NOT NULL,           -- economic-time; drives as-of math (dual-date #2)
  billing_posted_period       CHAR(7)     NOT NULL            -- 'YYYY-MM' open period (D-2)
                                CHECK (billing_posted_period ~ '^\d{4}-\d{2}$'),
  recognition_label           TEXT        NOT NULL
                                CHECK (recognition_label IN ('provisional', 'settling', 'finalized')),
  supersedes_ledger_event_id  TEXT        NULL,
  settlement_source           TEXT        NULL,
  maturity_state              TEXT        NULL,
  ledger_snapshot_id          TEXT        NULL,
  raw_event_id                TEXT        NULL,               -- Bronze event_id provenance
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, ledger_event_id)                     -- tenant-first; deterministic-id idempotency backstop
);

-- ── 2a. Dedup UNIQUE (D-4) ───────────────────────────────────────────────────
-- Distinguishes replay (same day → suppressed) from legit split-shipment
-- (different day → allowed). ON CONFLICT DO NOTHING at write time.
-- Use timezone('UTC', occurred_at)::date — this expression is IMMUTABLE
-- (timezone() with a constant zone string + timestamptz → timestamptz is immutable).
CREATE UNIQUE INDEX IF NOT EXISTS realized_revenue_ledger_dedup
  ON realized_revenue_ledger (brand_id, order_id, event_type, (timezone('UTC', occurred_at)::date));

-- ── 2b. As-of scan index (partial — serves realized_gmv_as_of) ───────────────
CREATE INDEX IF NOT EXISTS idx_rrl_asof
  ON realized_revenue_ledger (brand_id, economic_effective_at)
  WHERE event_type <> 'provisional_recognition';

-- ── 3. RLS — two-arg fail-closed (copy 0017 template exactly) ────────────────
ALTER TABLE realized_revenue_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE realized_revenue_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY realized_revenue_ledger_isolation ON realized_revenue_ledger
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 4. Append-only by GRANT (D-2) — NO UPDATE / NO DELETE ────────────────────
-- brain_app gets SELECT + INSERT ONLY. Any UPDATE or DELETE attempt by brain_app
-- will fail with "permission denied". Proven at migration time by assertion-2 below.
REVOKE ALL ON realized_revenue_ledger FROM brain_app;
GRANT SELECT, INSERT ON realized_revenue_ledger TO brain_app;

-- ── 5. BEFORE INSERT currency trigger (D-6) ──────────────────────────────────
-- Structural guard: rejects any INSERT whose currency_code ≠ brand.currency_code.
-- The trigger reads brand under RLS (same brand context) → tenant-safe.
-- Complements assertSameCurrency in packages/money (which covers TS arithmetic).
CREATE OR REPLACE FUNCTION ledger_currency_matches_brand()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE
  brand_currency CHAR(3);
BEGIN
  SELECT currency_code INTO brand_currency
  FROM brand
  WHERE id = NEW.brand_id;

  IF brand_currency IS NULL THEN
    RAISE EXCEPTION
      'currency_trigger: brand % not found or has no currency_code', NEW.brand_id;
  END IF;

  IF NEW.currency_code <> brand_currency THEN
    RAISE EXCEPTION
      'currency mismatch: ledger row currency=% but brand % currency=%. '
      'All ledger rows for a brand must share its currency_code.',
      NEW.currency_code, NEW.brand_id, brand_currency;
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER trg_ledger_currency
  BEFORE INSERT ON realized_revenue_ledger
  FOR EACH ROW
  EXECUTE FUNCTION ledger_currency_matches_brand();

-- ── 6. realized_gmv_as_of (D-3) — the no-double-count named function ─────────
-- STABLE SECURITY INVOKER: executes under caller's RLS context.
-- Cross-brand read = 0 under brain_app (RLS filters brand_id).
-- Excludes provisional_recognition — SOLE as-of path; no ad-hoc SUM permitted.
-- event_type contribution map:
--   provisional_recognition   EXCLUDED (not yet realized; no double-count)
--   finalization              +  (realized GMV)
--   rto_reversal              -  (clawback)
--   refund                    -
--   chargeback                -
--   cancellation              -
--   settlement_fee_reversal   -
--   marketplace_adjustment    ± (signed as written)
--   payment_adjustment        ± (signed as written)
--   concession                -
CREATE OR REPLACE FUNCTION realized_gmv_as_of(p_brand_id UUID, p_as_of DATE)
  RETURNS BIGINT
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT COALESCE(SUM(amount_minor), 0)::BIGINT
  FROM realized_revenue_ledger
  WHERE brand_id = p_brand_id
    AND economic_effective_at::date <= p_as_of
    AND event_type <> 'provisional_recognition';
$$;

-- ── 7. Migration-time assertions ──────────────────────────────────────────────

-- Assertion-1: NN-1 — all RLS policies use two-arg current_setting (copy 0017 DO-block)
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE (
      -- one-arg app.current_brand_id (no TRUE second arg)
      (qual LIKE '%current_setting(''app.current_brand_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      OR
      -- one-arg app.current_user_id
      (qual LIKE '%current_setting(''app.current_user_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_user_id'', true)%')
      OR
      -- one-arg app.current_workspace_id
      (qual LIKE '%current_setting(''app.current_workspace_id'')%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.current_workspace_id'', true)%')
      OR
      -- one-arg app.role
      (qual LIKE '%current_setting(''app.role'')%'
       AND qual NOT LIKE '%current_setting(''app.role'', TRUE)%'
       AND qual NOT LIKE '%current_setting(''app.role'', true)%')
    )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''guc_name'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- Assertion-2: Append-only-by-GRANT — brain_app must NOT hold UPDATE or DELETE
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name   = 'realized_revenue_ledger'
      AND grantee      = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on realized_revenue_ledger. '
      'Only SELECT and INSERT are permitted (D-2 structural immutability).',
      bad_grant.privilege_type;
  END LOOP;
END
$$;

-- Assertion-3: No-float-SQL — every *_minor column on this table must be bigint
DO $$
DECLARE
  bad_col RECORD;
BEGIN
  FOR bad_col IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name  = 'realized_revenue_ledger'
      AND column_name LIKE '%_minor'
      AND data_type  <> 'bigint'
  LOOP
    RAISE EXCEPTION
      'NO-FLOAT-SQL VIOLATION (M-2): Column "%" on realized_revenue_ledger has '
      'type "%" — must be bigint. Float/NUMERIC money columns are banned (I-S07).',
      bad_col.column_name, bad_col.data_type;
  END LOOP;
END
$$;
