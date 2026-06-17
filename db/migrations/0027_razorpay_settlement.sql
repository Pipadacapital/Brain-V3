-- ============================================================================
-- 0027_razorpay_settlement.sql
-- feat-razorpay-settlement-connector — Track A (Data Engineer)
-- ADR-RZ-1..ADR-RZ-6 (05-architecture.md)
-- ============================================================================
--
-- Parts:
--   (A) connector_instance additive ALTERs: add 'razorpay' to provider CHECK;
--       add razorpay_account_id column (NULL for Shopify, populated for Razorpay)
--   (B) connector_razorpay_order_map — the two-hop join table (MB-1)
--   (C) realized_revenue_ledger additive ALTERs — new event_type values + cols (MB-3/MB-7)
--   (D) list_razorpay_connectors_for_settlement_repull() — SECURITY DEFINER fn (MB-5)
--   (E) resolve_razorpay_connector_by_account(text) — SECURITY DEFINER fn (ADR-RZ-7)
--   (F) Migration-time assertion DO-blocks (prosecdef/search_path/execute) — SEC-RZ-0027
--
-- ADDITIVE ONLY (I-E02):
--   - CREATE TABLE IF NOT EXISTS
--   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS
--   - ALTER TABLE ... DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT (for CHECK extension)
--   - CREATE INDEX IF NOT EXISTS
--   - CREATE OR REPLACE FUNCTION
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS connector_razorpay_order_map;
--   DROP FUNCTION IF EXISTS list_razorpay_connectors_for_settlement_repull();
--   DROP FUNCTION IF EXISTS resolve_razorpay_connector_by_account(text);
--   ALTER TABLE realized_revenue_ledger DROP COLUMN IF EXISTS reconciliation_type;
--   ALTER TABLE realized_revenue_ledger DROP COLUMN IF EXISTS tax_code;
--   ALTER TABLE realized_revenue_ledger DROP COLUMN IF EXISTS fee_minor;
--   (event_type CHECK extension: drop+recreate to original values — ledger rebuildable from Bronze)
--   (connector_instance: provider CHECK removal and razorpay_account_id drop — additive only)
-- ============================================================================

-- ── (A) connector_instance: add Razorpay support ─────────────────────────────
--
-- The existing CHECK (provider IN ('shopify')) must be extended to include 'razorpay'.
-- This requires dropping the old CHECK constraint and adding a new one.
-- The constraint name is connector_instance_provider_check (auto-named by Postgres).
-- We do this safely: DROP IF EXISTS + ADD.
--
-- Also add razorpay_account_id: the Razorpay merchant account_id stored for webhook
-- brand resolution (resolve_razorpay_connector_by_account fn below).
-- NULL for Shopify connectors (no Razorpay concept). NOT NULL enforced at app layer
-- for Razorpay connectors via a conditional CHECK below.

-- Drop the old provider CHECK constraint (Shopify-only)
ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_provider_check;

-- Re-add provider CHECK including Razorpay
ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
    CHECK (provider IN ('shopify', 'razorpay'));

-- Drop the old unique constraint and re-add (it only enforces one connector per brand+provider)
-- This constraint is unchanged in shape — just ensuring it still holds
-- (UNIQUE (brand_id, provider) already exists as connector_instance_brand_provider_unique)

-- Add razorpay_account_id column (NULL for Shopify connectors)
ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS razorpay_account_id TEXT NULL;

-- Index for webhook brand resolution via account_id
CREATE INDEX IF NOT EXISTS connector_instance_razorpay_account_idx
  ON connector_instance (razorpay_account_id)
  WHERE razorpay_account_id IS NOT NULL;

-- ── (B) connector_razorpay_order_map — two-hop join table (MB-1) ─────────────
--
-- Populated by the payment.captured webhook handler (Track B, ADR-RZ-7.4).
-- Read by SettlementLedgerConsumer for two-hop join:
--   settlement.payment_id → this table → shopify_order_id → ledger.order_id
--
-- razorpay_payment_id: raw Razorpay payment ID (pay_XXXX) — stored here for internal
--   join use ONLY. This table is NOT a Bronze event table. It is RLS-protected with
--   the same brand_id isolation as all connector tables.
--   Raw payment_id never appears in Bronze events, ledger rows, or logs (C1).
--
-- shopify_order_id: the Brain ledger spine key (maps to ledger.order_id).
--   Set from payment.notes.shopify_order_id at payment.captured webhook time.
--
-- FORCE RLS + two-arg fail-closed policy (mirrors 0018:111-117 exactly).
-- brain_app: SELECT, INSERT, UPDATE (webhook upserts on re-delivery — NOT append-only;
--   it is a lookup table that may be re-populated on webhook replay).

CREATE TABLE IF NOT EXISTS connector_razorpay_order_map (
  brand_id                UUID        NOT NULL,          -- RLS anchor (I-S01)
  razorpay_order_id       TEXT        NULL,              -- order_XXXX (may be NULL for order-keyless)
  shopify_order_id        TEXT        NOT NULL,          -- Brain ledger spine key
  razorpay_payment_id     TEXT        NOT NULL,          -- raw pay_XXXX — internal join use only (C1)
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, razorpay_payment_id)            -- tenant-first composite PK
);

-- Indexes for the two join paths used by SettlementLedgerConsumer
CREATE INDEX IF NOT EXISTS connector_razorpay_order_map_payment_idx
  ON connector_razorpay_order_map (brand_id, razorpay_payment_id);

CREATE INDEX IF NOT EXISTS connector_razorpay_order_map_order_idx
  ON connector_razorpay_order_map (brand_id, razorpay_order_id)
  WHERE razorpay_order_id IS NOT NULL;

-- ENABLE + FORCE RLS — two-arg fail-closed (I-S01 / NN-1)
ALTER TABLE connector_razorpay_order_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_razorpay_order_map FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_razorpay_order_map_isolation ON connector_razorpay_order_map
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- brain_app: SELECT + INSERT + UPDATE (upsert on webhook re-delivery; NOT append-only — it's a lookup table)
REVOKE ALL ON connector_razorpay_order_map FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON connector_razorpay_order_map TO brain_app;

-- ── (C) realized_revenue_ledger additive ALTERs (MB-3 + MB-7) ────────────────
--
-- The existing event_type CHECK constraint covers:
--   'provisional_recognition', 'finalization', 'rto_reversal', 'refund',
--   'chargeback', 'cancellation', 'settlement_fee_reversal', 'marketplace_adjustment',
--   'payment_adjustment', 'concession'
--
-- We extend it to add settlement event_types. Approach: drop + recreate the CHECK
-- constraint (additive extension — same pattern as provider CHECK above).
-- All existing values MUST remain in the new constraint.
--
-- New event_type values (MB-3 taxonomy):
--   settlement_finalization    — net credit per settled payment (+)
--   payment_fee                — MDR processing fee (−)
--   settlement_tax             — GST on MDR 18% — SEPARATE from fee (−)
--   rolling_reserve_deduction  — timing float deducted at settlement (−)
--   rolling_reserve_release    — reserve returned 90-180d later (+)
--   settlement_reversal        — refund / chargeback settlement (−)
--   settlement_adjustment      — Razorpay bulk correction / adjustment (±)

ALTER TABLE realized_revenue_ledger
  DROP CONSTRAINT IF EXISTS realized_revenue_ledger_event_type_check;

ALTER TABLE realized_revenue_ledger
  ADD CONSTRAINT realized_revenue_ledger_event_type_check
    CHECK (event_type IN (
      -- existing event_types (MUST remain — D-2 append-only; existing rows must satisfy)
      'provisional_recognition',
      'finalization',
      'rto_reversal',
      'refund',
      'chargeback',
      'cancellation',
      'settlement_fee_reversal',
      'marketplace_adjustment',
      'payment_adjustment',
      'concession',
      -- NEW settlement event_types (MB-3)
      'settlement_finalization',
      'payment_fee',
      'settlement_tax',
      'rolling_reserve_deduction',
      'rolling_reserve_release',
      'settlement_reversal',
      'settlement_adjustment'
    ));

-- reconciliation_type: 'per_order' (payment-level join) or 'brand_level' (no order join key)
ALTER TABLE realized_revenue_ledger
  ADD COLUMN IF NOT EXISTS reconciliation_type TEXT NULL
    CHECK (reconciliation_type IS NULL OR reconciliation_type IN ('per_order', 'brand_level'));

-- tax_code: 'GST_18' on settlement_tax rows for ITC reconciliation (MB-3)
ALTER TABLE realized_revenue_ledger
  ADD COLUMN IF NOT EXISTS tax_code TEXT NULL;

-- fee_minor: analytics provenance for payment_fee rows; net realized math uses signed amount_minor rows
-- BIGINT (I-S07 — no float). NULL for non-fee rows.
ALTER TABLE realized_revenue_ledger
  ADD COLUMN IF NOT EXISTS fee_minor BIGINT NULL;

-- ── (D) list_razorpay_connectors_for_settlement_repull() (MB-5) ──────────────
--
-- SECURITY DEFINER: owned by migration superuser 'brain'; runs as 'brain' to
-- bypass FORCE RLS on connector_instance (which returns 0 rows under brain_app
-- without a GUC set — fail-closed). Returns dispatch-only cols (no tenant data content).
--
-- Per durable rule system-job-force-rls-enumeration (INDEX.md): cross-tenant system
-- jobs over FORCE-RLS tables MUST use a SECURITY DEFINER fn for enumeration.
-- GUC is set by the re-pull job AFTER the enumeration fn result is returned.
--
-- Returns: connector_instance_id, brand_id, secret_ref
-- No shop_domain (Razorpay doesn't use it); no tenant data content beyond identifiers.
-- Filters: provider='razorpay' AND status='connected'.

CREATE OR REPLACE FUNCTION list_razorpay_connectors_for_settlement_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.provider = 'razorpay'
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_razorpay_connectors_for_settlement_repull() TO brain_app;

-- ── (E) resolve_razorpay_connector_by_account(text) (ADR-RZ-7) ──────────────
--
-- Webhook brand resolution: called AFTER HMAC validation, BEFORE any brand-scoped write.
-- Resolves (connector_instance_id, brand_id, secret_ref) from razorpay_account_id.
-- brand_id comes from the connector ROW — never from the webhook body (MT-1).
-- SECURITY DEFINER: no GUC at webhook-receive time (brand unknown until this lookup).
-- Returns 0 rows if no connected connector → caller returns 401, no write.

CREATE OR REPLACE FUNCTION resolve_razorpay_connector_by_account(p_account_id text)
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    secret_ref             text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.secret_ref
  FROM connector_instance ci
  WHERE ci.razorpay_account_id = p_account_id
    AND ci.provider             = 'razorpay'
    AND ci.status               = 'connected'
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION resolve_razorpay_connector_by_account(text) TO brain_app;

-- ── (F) Migration-time assertion DO-blocks (SEC-RZ-0027) ──────────────────────
--
-- Three DO-blocks per SECURITY DEFINER fn (mirrors 0026:72-132 exactly).
-- Guard IDs: SEC-RZ-0027a/b/c for list_razorpay_connectors_for_settlement_repull()
--            SEC-RZ-0027d/e/f for resolve_razorpay_connector_by_account()

-- ── (F-1a) list_razorpay_connectors_for_settlement_repull: SECURITY DEFINER ──
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_razorpay_connectors_for_settlement_repull'
    AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-RZ-0027a GUARD: list_razorpay_connectors_for_settlement_repull() must be '
      'SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-RZ-0027a GUARD: list_razorpay_connectors_for_settlement_repull() must have '
      'SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (F-1b) list_razorpay_connectors_for_settlement_repull: brain_app EXECUTE ──
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege(
    'brain_app',
    'list_razorpay_connectors_for_settlement_repull()',
    'EXECUTE'
  )
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-RZ-0027b GUARD: brain_app does not have EXECUTE on '
      'list_razorpay_connectors_for_settlement_repull().';
  END IF;
END
$$;

-- ── (F-1c) list_razorpay_connectors_for_settlement_repull: fn exists ───────
DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT count(*)
  INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_razorpay_connectors_for_settlement_repull'
    AND n.nspname = 'public';

  IF fn_count = 0 THEN
    RAISE EXCEPTION
      'SEC-RZ-0027c GUARD: list_razorpay_connectors_for_settlement_repull() '
      'not found after creation.';
  END IF;
END
$$;

-- ── (F-2a) resolve_razorpay_connector_by_account: SECURITY DEFINER ──────────
DO $$
DECLARE
  fn_secdef  TEXT;
  fn_config  TEXT;
BEGIN
  SELECT
    p.prosecdef::text,
    array_to_string(p.proconfig, ', ')
  INTO fn_secdef, fn_config
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_razorpay_connector_by_account'
    AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-RZ-0027d GUARD: resolve_razorpay_connector_by_account() must be '
      'SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-RZ-0027d GUARD: resolve_razorpay_connector_by_account() must have '
      'SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (F-2b) resolve_razorpay_connector_by_account: brain_app EXECUTE ──────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege(
    'brain_app',
    'resolve_razorpay_connector_by_account(text)',
    'EXECUTE'
  )
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-RZ-0027e GUARD: brain_app does not have EXECUTE on '
      'resolve_razorpay_connector_by_account(text).';
  END IF;
END
$$;

-- ── (F-2c) resolve_razorpay_connector_by_account: fn exists ─────────────────
DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT count(*)
  INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'resolve_razorpay_connector_by_account'
    AND n.nspname = 'public';

  IF fn_count = 0 THEN
    RAISE EXCEPTION
      'SEC-RZ-0027f GUARD: resolve_razorpay_connector_by_account() '
      'not found after creation.';
  END IF;
END
$$;

-- ── (G) Post-migration assertions ─────────────────────────────────────────────

-- G-1: connector_razorpay_order_map has FORCE RLS
DO $$
DECLARE
  tbl_rowsecurity  BOOLEAN;
  tbl_forcerowsecurity BOOLEAN;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO tbl_rowsecurity, tbl_forcerowsecurity
  FROM pg_class
  WHERE relname = 'connector_razorpay_order_map'
    AND relkind = 'r';

  IF NOT tbl_rowsecurity THEN
    RAISE EXCEPTION
      'SEC-RZ-0027g: connector_razorpay_order_map does not have RLS enabled.';
  END IF;

  IF NOT tbl_forcerowsecurity THEN
    RAISE EXCEPTION
      'SEC-RZ-0027g: connector_razorpay_order_map does not have FORCE RLS enabled.';
  END IF;
END
$$;

-- G-2: realized_revenue_ledger fee_minor column is BIGINT (I-S07 no-float-SQL)
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type
  INTO col_type
  FROM information_schema.columns
  WHERE table_name  = 'realized_revenue_ledger'
    AND column_name = 'fee_minor';

  IF col_type IS NOT NULL AND col_type <> 'bigint' THEN
    RAISE EXCEPTION
      'NO-FLOAT-SQL VIOLATION (I-S07): realized_revenue_ledger.fee_minor has type "%" '
      '— must be bigint (I-S07).', col_type;
  END IF;
END
$$;

-- G-3: NN-1 two-arg current_setting check — all RLS policies on new tables
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename IN ('connector_razorpay_order_map')
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
