-- ============================================================================
-- 0029_ad_spend.sql
-- feat-ad-connectors (Slice 1) — Track 2 (Data Engineer)
-- ADR-AD-1..ADR-AD-9 (05-architecture.md)
-- ============================================================================
--
-- NOTE ON NUMBERING: the architecture plan named this "0028_ad_spend.sql" but
-- 0028 was taken by feat-collection-foundation (0028_resolve_brand_by_install_token.sql,
-- merged to master concurrently). Next free number is 0029. Content is unchanged.
--
-- Mirrors 0027_razorpay_settlement.sql structure exactly. Parts:
--   (A) connector_instance: extend provider CHECK to include meta/google_ads;
--       add ad_account_id column (NULL for shopify/razorpay) + partial index
--   (B) ad_spend_ledger — append-only fact (FORCE-RLS, GRANT-append, ON CONFLICT dedup)
--   (C) ad_spend_as_of(uuid, date, date) — SECURITY INVOKER read seam (sole spend read path)
--   (D) list_ad_connectors_for_spend_repull() — SECURITY DEFINER enumeration fn
--   (E) Migration-time assertion DO-blocks (SEC-AD-0029a/b/c) — prosecdef/search_path/grant
--   (F) Post-migration assertions: RLS+FORCE, spend_minor BIGINT (I-S07), NN-1 two-arg
--
-- ADDITIVE ONLY (I-E02):
--   - CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS
--   - ALTER TABLE DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT (CHECK extension)
--   - CREATE INDEX IF NOT EXISTS / CREATE OR REPLACE FUNCTION
--
-- ROLLBACK (ledger rebuildable from Bronze — safe):
--   DROP TABLE IF EXISTS ad_spend_ledger;
--   DROP FUNCTION IF EXISTS ad_spend_as_of(uuid, date, date);
--   DROP FUNCTION IF EXISTS list_ad_connectors_for_spend_repull();
--   ALTER TABLE connector_instance DROP COLUMN IF EXISTS ad_account_id;
--   (provider CHECK extension: drop+recreate to ('shopify','razorpay') — additive only)
-- ============================================================================

-- ── (A) connector_instance: add Meta + Google Ads support ────────────────────
--
-- Extend the provider CHECK (currently ('shopify','razorpay')) to add the two ad
-- platforms. DROP IF EXISTS + ADD (same safe pattern as 0027:42-50).
--
-- ad_account_id: the ad-platform account ref (Meta ad_account_id / Google customer_id)
-- stored for connect identity + webhook-free brand resolution. NULL for shopify/razorpay.

ALTER TABLE connector_instance
  DROP CONSTRAINT IF EXISTS connector_instance_provider_check;

ALTER TABLE connector_instance
  ADD CONSTRAINT connector_instance_provider_check
    CHECK (provider IN ('shopify', 'razorpay', 'meta', 'google_ads'));

-- Ad-platform account ref (NULL for shopify/razorpay connectors)
ALTER TABLE connector_instance
  ADD COLUMN IF NOT EXISTS ad_account_id TEXT NULL;

-- Index for brand resolution via ad_account_id
CREATE INDEX IF NOT EXISTS connector_instance_ad_account_idx
  ON connector_instance (ad_account_id)
  WHERE ad_account_id IS NOT NULL;

-- ── (B) ad_spend_ledger — append-only spend fact (ADR-AD-6) ──────────────────
--
-- Distinct economic concept (spend), distinct grain
-- (platform × campaign/adset/ad/creative × stat-date) — NOT folded into
-- realized_revenue_ledger (would corrupt realized_gmv_as_of() SUM).
--
-- FORCE RLS + two-arg fail-closed policy (mirrors 0027:141-147 exactly).
-- Append-only by GRANT: brain_app holds SELECT + INSERT only (NO UPDATE/DELETE — I-E02).
-- Dedup: ON CONFLICT (brand_id, platform, level, level_id, stat_date) DO NOTHING.
--   Spend is fixed at click-date (ADR-AD-8) so spend_minor for a given key is stable;
--   the trailing re-read replays the same key → DO NOTHING (idempotent — I-ST04).

CREATE TABLE IF NOT EXISTS ad_spend_ledger (
  brand_id              UUID        NOT NULL,                 -- RLS anchor (I-S01)
  spend_event_id        TEXT        NOT NULL,                 -- deterministic dedup id (ADR-AD-5)
  platform              TEXT        NOT NULL CHECK (platform IN ('meta', 'google_ads')),
  level                 TEXT        NOT NULL CHECK (level IN ('campaign', 'adset', 'ad', 'creative')),
  level_id              TEXT        NOT NULL,                 -- platform-native id (operational ref, not PII — I-S02)
  parent_id             TEXT        NULL,                     -- hierarchy edge (campaign→adset→ad→creative)
  campaign_id           TEXT        NULL,
  campaign_name         TEXT        NULL,                     -- display only (allowlisted; not PII)
  stat_date             DATE        NOT NULL,                 -- click-date anchored (canonical, ADR-AD-8)
  spend_minor           BIGINT      NOT NULL,                 -- I-S07 minor units, NO float
  currency_code         CHAR(3)     NOT NULL,
  impressions           BIGINT      NULL,
  clicks                BIGINT      NULL,
  conversions_raw       JSONB       NULL,                     -- RAW conversions/all_conversions (ADR-AD-8)
  account_timezone      TEXT        NULL,                     -- platform stat tz (timezone-aware mapping)
  raw_event_id          TEXT        NOT NULL,                 -- Bronze provenance
  occurred_at           TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (brand_id, spend_event_id)
);

-- Dedup / restatement key (I-ST04): re-read the same (platform,level,level_id,stat_date) → DO NOTHING.
CREATE UNIQUE INDEX IF NOT EXISTS ad_spend_ledger_dedup_key
  ON ad_spend_ledger (brand_id, platform, level, level_id, stat_date);

-- Read-seam support index (brand + date range scans)
CREATE INDEX IF NOT EXISTS ad_spend_ledger_brand_date_idx
  ON ad_spend_ledger (brand_id, stat_date);

-- ENABLE + FORCE RLS — two-arg fail-closed (I-S01 / NN-1)
ALTER TABLE ad_spend_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE ad_spend_ledger FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_spend_ledger_isolation ON ad_spend_ledger;
CREATE POLICY ad_spend_ledger_isolation ON ad_spend_ledger
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- Append-only (I-E02): SELECT + INSERT only — NO UPDATE/DELETE on a fact table.
REVOKE ALL ON ad_spend_ledger FROM brain_app;
GRANT SELECT, INSERT ON ad_spend_ledger TO brain_app;

-- ── (C) ad_spend_as_of(uuid, date, date) — read seam (ADR-AD-6) ──────────────
--
-- SECURITY INVOKER: executes under the caller's RLS context (brand GUC set by the
-- metric engine inside withBrandTxn). The SOLE spend read path for the metric engine
-- (mirrors realized_gmv_as_of, 0018:175). Returns SUM(spend_minor) per
-- (platform, currency_code) over the inclusive [p_from, p_to] stat_date window.
--
-- Cross-brand read = 0 under brain_app (RLS filters brand_id). No ad-hoc SUM permitted.

CREATE OR REPLACE FUNCTION ad_spend_as_of(
  p_brand_id UUID,
  p_from     DATE,
  p_to       DATE
)
  RETURNS TABLE(
    platform       TEXT,
    currency_code  CHAR(3),
    spend_minor    BIGINT
  )
  LANGUAGE sql
  STABLE
  SECURITY INVOKER
AS $$
  SELECT
    l.platform,
    l.currency_code,
    COALESCE(SUM(l.spend_minor), 0)::BIGINT AS spend_minor
  FROM ad_spend_ledger l
  WHERE l.brand_id  = p_brand_id
    AND l.stat_date >= p_from
    AND l.stat_date <= p_to
  GROUP BY l.platform, l.currency_code
$$;

-- ── (D) list_ad_connectors_for_spend_repull() — SECURITY DEFINER (ADR-AD-3) ──
--
-- Mirrors 0027:190-211 exactly. Owned by migration superuser 'brain'; runs as 'brain'
-- to bypass FORCE RLS on connector_instance (returns 0 rows under brain_app without a
-- GUC — fail-closed). The re-pull job sets the brand GUC AFTER this enumeration returns
-- (durable rule: system-job-force-rls-enumeration).
--
-- Returns dispatch-only cols (no tenant data content). Filters: provider IN ('meta',
-- 'google_ads') AND status='connected'.

CREATE OR REPLACE FUNCTION list_ad_connectors_for_spend_repull()
  RETURNS TABLE(
    connector_instance_id  uuid,
    brand_id               uuid,
    provider               text,
    secret_ref             text,
    ad_account_id          text
  )
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT
    ci.id             AS connector_instance_id,
    ci.brand_id,
    ci.provider,
    ci.secret_ref,
    ci.ad_account_id
  FROM connector_instance ci
  WHERE ci.provider IN ('meta', 'google_ads')
    AND ci.status   = 'connected'
  ORDER BY ci.created_at ASC
$$;

GRANT EXECUTE ON FUNCTION list_ad_connectors_for_spend_repull() TO brain_app;

-- ── (E) Migration-time assertion DO-blocks (SEC-AD-0029) ─────────────────────
--
-- Three DO-blocks for the SECURITY DEFINER enumeration fn (mirrors 0027:251-318).
-- Guard IDs: SEC-AD-0029a (SECURITY DEFINER + search_path), SEC-AD-0029b (brain_app
-- EXECUTE), SEC-AD-0029c (fn exists).

-- ── (E-a) list_ad_connectors_for_spend_repull: SECURITY DEFINER + search_path ─
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
  WHERE p.proname = 'list_ad_connectors_for_spend_repull'
    AND n.nspname = 'public';

  IF fn_secdef IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION
      'SEC-AD-0029a GUARD: list_ad_connectors_for_spend_repull() must be '
      'SECURITY DEFINER (prosecdef=true). Got: %', fn_secdef;
  END IF;

  IF fn_config IS NULL OR fn_config NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION
      'SEC-AD-0029a GUARD: list_ad_connectors_for_spend_repull() must have '
      'SET search_path=public. Got config: %', fn_config;
  END IF;
END
$$;

-- ── (E-b) list_ad_connectors_for_spend_repull: brain_app EXECUTE ─────────────
DO $$
DECLARE
  has_execute BOOLEAN;
BEGIN
  SELECT has_function_privilege(
    'brain_app',
    'list_ad_connectors_for_spend_repull()',
    'EXECUTE'
  )
  INTO has_execute;

  IF NOT has_execute THEN
    RAISE EXCEPTION
      'SEC-AD-0029b GUARD: brain_app does not have EXECUTE on '
      'list_ad_connectors_for_spend_repull().';
  END IF;
END
$$;

-- ── (E-c) list_ad_connectors_for_spend_repull: fn exists ─────────────────────
DO $$
DECLARE
  fn_count INT;
BEGIN
  SELECT count(*)
  INTO fn_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.proname = 'list_ad_connectors_for_spend_repull'
    AND n.nspname = 'public';

  IF fn_count = 0 THEN
    RAISE EXCEPTION
      'SEC-AD-0029c GUARD: list_ad_connectors_for_spend_repull() not found after creation.';
  END IF;
END
$$;

-- ── (F) Post-migration assertions ────────────────────────────────────────────

-- F-1: ad_spend_ledger has RLS + FORCE RLS enabled (I-S01)
DO $$
DECLARE
  tbl_rowsecurity      BOOLEAN;
  tbl_forcerowsecurity BOOLEAN;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO tbl_rowsecurity, tbl_forcerowsecurity
  FROM pg_class
  WHERE relname = 'ad_spend_ledger'
    AND relkind = 'r';

  IF NOT tbl_rowsecurity THEN
    RAISE EXCEPTION 'SEC-AD-0029d: ad_spend_ledger does not have RLS enabled.';
  END IF;

  IF NOT tbl_forcerowsecurity THEN
    RAISE EXCEPTION 'SEC-AD-0029d: ad_spend_ledger does not have FORCE RLS enabled.';
  END IF;
END
$$;

-- F-2: ad_spend_ledger.spend_minor is BIGINT (I-S07 NO-FLOAT-SQL guard)
DO $$
DECLARE
  col_type TEXT;
BEGIN
  SELECT data_type
  INTO col_type
  FROM information_schema.columns
  WHERE table_name  = 'ad_spend_ledger'
    AND column_name = 'spend_minor';

  IF col_type IS NULL THEN
    RAISE EXCEPTION 'SEC-AD-0029e: ad_spend_ledger.spend_minor column not found.';
  END IF;

  IF col_type <> 'bigint' THEN
    RAISE EXCEPTION
      'NO-FLOAT-SQL VIOLATION (I-S07): ad_spend_ledger.spend_minor has type "%" '
      '— must be bigint (I-S07).', col_type;
  END IF;
END
$$;

-- F-3: append-only-by-GRANT — brain_app must NOT hold UPDATE or DELETE on the fact (I-E02)
DO $$
DECLARE
  has_update BOOLEAN;
  has_delete BOOLEAN;
BEGIN
  SELECT
    has_table_privilege('brain_app', 'ad_spend_ledger', 'UPDATE'),
    has_table_privilege('brain_app', 'ad_spend_ledger', 'DELETE')
  INTO has_update, has_delete;

  IF has_update THEN
    RAISE EXCEPTION
      'I-E02 VIOLATION: brain_app holds UPDATE on ad_spend_ledger — fact must be append-only.';
  END IF;

  IF has_delete THEN
    RAISE EXCEPTION
      'I-E02 VIOLATION: brain_app holds DELETE on ad_spend_ledger — fact must be append-only.';
  END IF;
END
$$;

-- F-4: NN-1 two-arg current_setting check — all RLS policies on the new table
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename IN ('ad_spend_ledger')
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
