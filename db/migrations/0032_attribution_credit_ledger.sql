-- ============================================================================
-- 0032_attribution_credit_ledger.sql — Attribution Credit Ledger (Gold SoR)
-- feat-attribution-ledger (Phase 5, Stage 3). Deterministic compute only — tier-0.
-- Mirrors 0018_realized_revenue_ledger.sql EXACTLY: append-only by GRANT, RLS
-- ENABLE+FORCE two-arg fail-closed, deterministic credit_id, signed money BIGINT,
-- the currency-matches-brand trigger, and the three migration-time DO-block
-- assertions (NN-1 two-arg, append-only-by-GRANT, no-float-SQL).
-- ============================================================================
-- WHY POSTGRES (not StarRocks brain_gold) — architecture 05 §1:
--   • The metric engine is the WRITER and needs append-only + RLS FORCE + signed
--     integer money + deterministic-ID idempotency. Dev StarRocks (allin1 3.3.2)
--     has NO RLS (row-policy is enterprise-only → isolation would be INERT, failing
--     the NON-INERT gate) and no append-only-by-grant immutability.
--   • Clawback is a transactional, idempotent append keyed on a deterministic
--     reversal id → ON CONFLICT DO NOTHING (Postgres row-grain). StarRocks has no
--     row-grain upsert-on-conflict idempotency.
--   • The parity oracle recomputes via independent SQL over the canonical store;
--     co-locating credit + realized revenue in Postgres lets the oracle JOIN both
--     in ONE transactional snapshot — no cross-store skew window (the integrity
--     property the CI gate depends on).
--   • `gold.` in METRICS.md is the LOGICAL System-of-Record tier name, NOT a
--     physical StarRocks schema. The shipped precedent is identical:
--     `gold.realized_revenue_ledger` → physical Postgres `realized_revenue_ledger`
--     (0018). This migration follows that exact precedent.
--
-- MONEY invariants (I-S07):
--   • credited_revenue_minor + realized_revenue_minor are BIGINT — NEVER NUMERIC/float.
--     credited_revenue_minor is SIGNED: positive on credit, negative on clawback.
--   • currency_code CHAR(3) is ALWAYS paired with every money column.
--   • weight_fraction DECIMAL(9,8) is EXACT (not a money column) — per-order weights
--     sum to exactly 1.0; saved at credit time and carried verbatim onto the clawback.
--
-- Tenant isolation (I-S01):
--   • ENABLE + FORCE ROW LEVEL SECURITY on attribution_credit_ledger.
--   • Two-arg fail-closed: current_setting('app.current_brand_id', TRUE) returns NULL
--     on missing GUC → brand_id = NULL → FALSE → 0 rows (proven NON-INERT by the
--     isolation-fuzz mutation test).
--
-- Append-only by GRANT (D-2):
--   • brain_app gets SELECT, INSERT ONLY — NO UPDATE, NO DELETE.
--     A credit row is NEVER mutated; a clawback is a NEW signed row. Proven at
--     migration time by assertion-2.
--
-- Deterministic id + replay-idempotency (D-4):
--   credit_id   = sha256(brand_id‖order_id‖brain_anon_id‖touch_seq‖model_id‖'credit'‖version)
--   clawback id = sha256(brand_id‖order_id‖brain_anon_id‖touch_seq‖model_id‖'clawback'‖reversal_ledger_event_id)
--   UNIQUE (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind, reversed_of_credit_id)
--   → writer uses ON CONFLICT DO NOTHING → replay produces no new rows.
--
-- Dual-date (D-2):
--   • occurred_at = conversion/reversal event-time; economic_effective_at = economic-time
--     (drives the as-of math); billing_posted_period = the reversal's current open period
--     (a clawback posts to the current period — closed/invoiced periods are never edited).
--
-- Single-currency-per-brand (D-6):
--   • BEFORE INSERT trigger rejects rows whose currency_code != brand.currency_code.
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE IF NOT EXISTS; CREATE OR REPLACE FUNCTION.
-- No new deployable (I-E05). The ledger is fully rebuildable from silver.touchpoint +
-- realized_revenue_ledger — DROP is safe (same property as 0018).
--
-- ROLLBACK (migrate down):
--   DROP TABLE IF EXISTS attribution_credit_ledger;
--   DROP FUNCTION IF EXISTS attributed_gmv_as_of(uuid, text, date);
--   DROP FUNCTION IF EXISTS channel_contribution_as_of(uuid, text, date, date);
--   DROP FUNCTION IF EXISTS attribution_confidence_mart(uuid, text, date, date);
--   DROP FUNCTION IF EXISTS attribution_credit_currency_matches_brand();
-- ============================================================================

-- ── 1. attribution_credit_ledger table (architecture 05 §1) ──────────────────
-- ONE ledger, row_kind discriminator (credit | clawback) — NOT per-kind tables.
-- Multiple model_id rows may coexist for one order (the brand's active model is
-- selected at READ time); channel is a COLUMN, never a table (no per-channel fork).
CREATE TABLE IF NOT EXISTS attribution_credit_ledger (
  brand_id                 UUID        NOT NULL,            -- tenant key / RLS anchor (I-S01)
  credit_id                TEXT        NOT NULL,            -- deterministic sha256 (see header)
  order_id                 TEXT        NOT NULL,
  brain_anon_id            TEXT        NOT NULL,            -- the journey key (silver.touchpoint)
  touch_seq                INT         NOT NULL,            -- conversion-order position of the credited touch
  channel                  TEXT        NOT NULL,            -- canonical JourneyChannel (column, not table)
  campaign_id              TEXT        NULL,
  model_id                 TEXT        NOT NULL
                             CHECK (model_id IN ('first_touch', 'last_touch', 'linear', 'position_based')),
  row_kind                 TEXT        NOT NULL
                             CHECK (row_kind IN ('credit', 'clawback')),
  weight_fraction          DECIMAL(9,8) NOT NULL,          -- EXACT; saved at credit time; verbatim on clawback
  credited_revenue_minor   BIGINT      NOT NULL,           -- SIGNED; +credit / -clawback; NEVER float (I-S07)
  currency_code            CHAR(3)     NOT NULL,           -- paired with credited_revenue_minor ALWAYS
  realized_revenue_minor   BIGINT      NOT NULL,           -- the order's realized basis used (provenance); BIGINT (I-S07)
  reversed_of_credit_id    TEXT        NULL,               -- non-null ONLY on clawback → points at the original credit_id
  reversal_reason          TEXT        NULL
                             CHECK (reversal_reason IS NULL OR reversal_reason IN
                               ('rto_reversal', 'refund', 'chargeback', 'cancellation', 'concession')),
  confidence_grade         TEXT        NOT NULL
                             CHECK (confidence_grade IN ('strong', 'partial', 'weak')),
  attribution_confidence   NUMERIC(4,3) NOT NULL,          -- frozen grade constant (1.000 / 0.700 / 0.400)
  model_version            TEXT        NOT NULL,           -- metric_version provenance
  metric_snapshot_id       TEXT        NULL,
  occurred_at              TIMESTAMPTZ NOT NULL,           -- conversion/reversal event-time (dual-date #1)
  economic_effective_at    TIMESTAMPTZ NOT NULL,           -- economic-time; drives as-of math (dual-date #2)
  billing_posted_period    CHAR(7)     NOT NULL            -- 'YYYY-MM' open period (D-2)
                             CHECK (billing_posted_period ~ '^\d{4}-\d{2}$'),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, credit_id),                       -- tenant-first; deterministic-id idempotency backstop
  -- A clawback row MUST carry reversed_of_credit_id; a credit row MUST NOT (structural).
  CONSTRAINT attribution_clawback_reversed_of CHECK (
    (row_kind = 'clawback') = (reversed_of_credit_id IS NOT NULL)
  ),
  -- A clawback carries a reversal_reason; a credit never does (structural).
  CONSTRAINT attribution_clawback_reason CHECK (
    (row_kind = 'clawback') = (reversal_reason IS NOT NULL)
  )
);

-- ── 1a. Dedup UNIQUE (D-4) — replay → ON CONFLICT DO NOTHING ──────────────────
-- Distinguishes a replay (same credit/clawback identity → suppressed) from a legit
-- distinct row. reversed_of_credit_id is part of the key so each distinct reversal
-- event of the same touch produces a distinct clawback, but a REPLAY of that reversal
-- collides → suppressed. NULL reversed_of_credit_id (credit rows) collapses via
-- COALESCE to a sentinel so the credit row uniqueness holds without NULL-skip.
CREATE UNIQUE INDEX IF NOT EXISTS attribution_credit_ledger_dedup
  ON attribution_credit_ledger
     (brand_id, order_id, brain_anon_id, touch_seq, model_id, row_kind,
      COALESCE(reversed_of_credit_id, ''));

-- ── 1b. As-of / read-seam scan index (serves attributed_gmv_as_of + channel) ──
CREATE INDEX IF NOT EXISTS idx_acl_asof
  ON attribution_credit_ledger (brand_id, model_id, economic_effective_at);

-- ── 1c. Reversal-lookup index (clawback fan-out reads the saved credit rows) ──
CREATE INDEX IF NOT EXISTS idx_acl_reversal
  ON attribution_credit_ledger (brand_id, reversed_of_credit_id)
  WHERE row_kind = 'clawback';

-- ── 2. RLS — two-arg fail-closed (copy 0018 §3 template exactly) ─────────────
ALTER TABLE attribution_credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_credit_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS attribution_credit_ledger_isolation ON attribution_credit_ledger;
CREATE POLICY attribution_credit_ledger_isolation ON attribution_credit_ledger
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 3. Append-only by GRANT (D-2) — NO UPDATE / NO DELETE ────────────────────
-- brain_app gets SELECT + INSERT ONLY. Any UPDATE/DELETE by brain_app → permission
-- denied. Proven at migration time by assertion-2 below.
REVOKE ALL ON attribution_credit_ledger FROM brain_app;
GRANT SELECT, INSERT ON attribution_credit_ledger TO brain_app;

-- ── 4. BEFORE INSERT currency trigger (D-6) — copy 0018 §5 ───────────────────
CREATE OR REPLACE FUNCTION attribution_credit_currency_matches_brand()
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
      'attribution_currency_trigger: brand % not found or has no currency_code', NEW.brand_id;
  END IF;

  IF NEW.currency_code <> brand_currency THEN
    RAISE EXCEPTION
      'currency mismatch: attribution_credit_ledger row currency=% but brand % currency=%. '
      'All credit rows for a brand must share its currency_code.',
      NEW.currency_code, NEW.brand_id, brand_currency;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_attribution_credit_currency ON attribution_credit_ledger;
CREATE TRIGGER trg_attribution_credit_currency
  BEFORE INSERT ON attribution_credit_ledger
  FOR EACH ROW
  EXECUTE FUNCTION attribution_credit_currency_matches_brand();

-- ── 5. attributed_gmv_as_of — the SOLE attributed-sum read path ──────────────
-- STABLE SECURITY INVOKER: executes under the caller's RLS context (cross-brand
-- read = 0 under brain_app). Mirrors realized_gmv_as_of (0018:175). SUMs SIGNED
-- credited_revenue_minor (credit positive + clawback negative net) for ONE model,
-- as-of a date. No ad-hoc SUM in app — this is the named seam.
CREATE OR REPLACE FUNCTION attributed_gmv_as_of(
  p_brand_id UUID,
  p_model_id TEXT,
  p_as_of    DATE
)
  RETURNS BIGINT
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT COALESCE(SUM(credited_revenue_minor), 0)::BIGINT
  FROM attribution_credit_ledger
  WHERE brand_id = p_brand_id
    AND model_id = p_model_id
    AND economic_effective_at::date <= p_as_of;
$$;

-- ── 6. channel_contribution_as_of — per-channel attributed contribution ──────
-- Feeds the UI (attributed revenue by channel) + the parity oracle. SIGNED net
-- (credit + clawback) per (channel, currency_code) for ONE model over [from, to].
-- SECURITY INVOKER → RLS-scoped. The unattributed residual is computed by the
-- engine as realized_gmv_as_of − attributed_gmv_as_of (never hidden, never spread).
CREATE OR REPLACE FUNCTION channel_contribution_as_of(
  p_brand_id UUID,
  p_model_id TEXT,
  p_from     DATE,
  p_to       DATE
)
  RETURNS TABLE(
    channel            TEXT,
    currency_code      CHAR(3),
    contribution_minor BIGINT
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT
    l.channel,
    l.currency_code,
    COALESCE(SUM(l.credited_revenue_minor), 0)::BIGINT AS contribution_minor
  FROM attribution_credit_ledger l
  WHERE l.brand_id = p_brand_id
    AND l.model_id = p_model_id
    AND l.economic_effective_at::date >= p_from
    AND l.economic_effective_at::date <= p_to
  GROUP BY l.channel, l.currency_code;
$$;

-- ── 7. attribution_confidence_mart — gold.attribution_confidence_mart seam ───
-- The logical gold.attribution_confidence_mart (architecture 05 §4), materialized
-- as a SECURITY-INVOKER function (no separate StarRocks object — same logical
-- gold. reasoning as §1). Returns attributed revenue grouped by confidence grade
-- for ONE model over [from, to]; feeds effective_confidence = min(cost, attribution).
CREATE OR REPLACE FUNCTION attribution_confidence_mart(
  p_brand_id UUID,
  p_model_id TEXT,
  p_from     DATE,
  p_to       DATE
)
  RETURNS TABLE(
    confidence_grade        TEXT,
    attribution_confidence  NUMERIC(4,3),
    attributed_minor        BIGINT
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT
    l.confidence_grade,
    l.attribution_confidence,
    COALESCE(SUM(l.credited_revenue_minor), 0)::BIGINT AS attributed_minor
  FROM attribution_credit_ledger l
  WHERE l.brand_id = p_brand_id
    AND l.model_id = p_model_id
    AND l.economic_effective_at::date >= p_from
    AND l.economic_effective_at::date <= p_to
  GROUP BY l.confidence_grade, l.attribution_confidence;
$$;

-- The three as-of seams are SECURITY INVOKER (run under caller RLS) — brain_app
-- needs EXECUTE. realized_gmv_as_of (0018) relies on the default PUBLIC EXECUTE;
-- we grant explicitly here for clarity and to match 0029's explicit-grant style.
GRANT EXECUTE ON FUNCTION attributed_gmv_as_of(UUID, TEXT, DATE)              TO brain_app;
GRANT EXECUTE ON FUNCTION channel_contribution_as_of(UUID, TEXT, DATE, DATE)  TO brain_app;
GRANT EXECUTE ON FUNCTION attribution_confidence_mart(UUID, TEXT, DATE, DATE) TO brain_app;

-- ============================================================================
-- 8. Migration-time assertions (copy 0018 §7 — the three DO-blocks)
-- ============================================================================

-- Assertion-1: NN-1 — RLS policies on this table use two-arg current_setting.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename = 'attribution_credit_ledger'
      AND (
        (qual LIKE '%current_setting(''app.current_brand_id'')%'
         AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
         AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%')
      )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''app.current_brand_id'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- Assertion-2: Append-only-by-GRANT — brain_app must NOT hold UPDATE or DELETE.
DO $$
DECLARE
  bad_grant RECORD;
BEGIN
  FOR bad_grant IN
    SELECT privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name     = 'attribution_credit_ledger'
      AND grantee        = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on attribution_credit_ledger. '
      'Only SELECT and INSERT are permitted (D-2 structural immutability).',
      bad_grant.privilege_type;
  END LOOP;
END
$$;

-- Assertion-3: No-float-SQL — every *_minor column on this table must be bigint.
DO $$
DECLARE
  bad_col RECORD;
BEGIN
  FOR bad_col IN
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name  = 'attribution_credit_ledger'
      AND column_name LIKE '%_minor'
      AND data_type  <> 'bigint'
  LOOP
    RAISE EXCEPTION
      'NO-FLOAT-SQL VIOLATION (I-S07): Column "%" on attribution_credit_ledger has '
      'type "%" — must be bigint. Float/NUMERIC money columns are banned (I-S07).',
      bad_col.column_name, bad_col.data_type;
  END LOOP;
END
$$;

-- Assertion-4: RLS + FORCE RLS enabled on the table (mirror 0029 F-1).
DO $$
DECLARE
  tbl_rowsecurity      BOOLEAN;
  tbl_forcerowsecurity BOOLEAN;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO tbl_rowsecurity, tbl_forcerowsecurity
  FROM pg_class
  WHERE relname = 'attribution_credit_ledger'
    AND relkind = 'r';

  IF NOT tbl_rowsecurity THEN
    RAISE EXCEPTION 'SEC-ACL-0032: attribution_credit_ledger does not have RLS enabled.';
  END IF;
  IF NOT tbl_forcerowsecurity THEN
    RAISE EXCEPTION 'SEC-ACL-0032: attribution_credit_ledger does not have FORCE RLS enabled.';
  END IF;
END
$$;
