-- ============================================================================
-- 0088_brand_config_history_scd.sql
-- AUDIT-REMEDIATION M3 — effective-dated (SCD-2) history for revenue-affecting brand config
-- ============================================================================
--
-- PROBLEM: revenue-affecting brand settings live as MUTABLE columns on tenancy.brand
--   (revenue_definition, cod_recognition_horizon_days, prepaid_recognition_horizon_days).
--   When a brand changes its revenue definition or recognition horizon, the old value is
--   overwritten in place — so a settlement/revenue figure computed LAST month cannot be
--   reproduced (the config that produced it is gone). Brain core rule: "revenue truth",
--   "data can be replayed and audited". Revenue-affecting config MUST be effective-dated.
--
-- SOLUTION (SCD-2, additive): an append-only history table that records, per config key,
--   the value and the interval [valid_from, valid_to) during which it was in effect. The
--   live tenancy.brand columns are KEPT AS-IS (the current/derived value); this table is
--   the time-travel record. A trigger captures every change so history is automatic and
--   cannot be forgotten by a write path.
--
-- WRITE PATH: AFTER UPDATE/INSERT trigger on tenancy.brand. On each revenue-affecting key
--   whose value changed, it CLOSES the open row (sets valid_to = now()) and OPENS a new row
--   (valid_from = now(), valid_to = NULL). The trigger runs as the table owner (definer-ish:
--   it inserts under the invoking role, which for app writes is brain_app under the brand GUC,
--   satisfying the RLS USING/CHECK on brand_id). Reads/replay query WHERE valid_from <= ts
--   AND (valid_to IS NULL OR valid_to > ts).
--
-- APPEND-ONLY: brain_app gets SELECT + INSERT only (no UPDATE/DELETE of history). The trigger
--   is the ONLY writer that closes a row — it runs with the table-owner's rights via SECURITY
--   DEFINER so the "close" UPDATE does not require brain_app to hold UPDATE on history.
--
-- ADDITIVE-ONLY (does NOT remove any brand column). ROLLBACK: DROP TRIGGER + DROP FUNCTION +
--   DROP TABLE tenancy.brand_config_history.

-- ── 1. The SCD-2 history table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenancy.brand_config_history (
  history_id    UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id      UUID        NOT NULL REFERENCES tenancy.brand(id) ON DELETE CASCADE,  -- RLS anchor + FK (history dies with the brand)
  config_key    TEXT        NOT NULL,                                -- e.g. 'revenue_definition'
  config_value  TEXT,                                               -- string-encoded value (NULL allowed)
  valid_from    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to      TIMESTAMPTZ,                                        -- NULL = currently in effect
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (history_id),
  CHECK (valid_to IS NULL OR valid_to >= valid_from)
);

-- Point-in-time lookup: "what was config_key for this brand at time T".
CREATE INDEX IF NOT EXISTS brand_config_history_pit_idx
  ON tenancy.brand_config_history (brand_id, config_key, valid_from DESC);
-- Cover the brand FK for FK-maintenance.
CREATE INDEX IF NOT EXISTS brand_config_history_brand_id_idx
  ON tenancy.brand_config_history (brand_id);
-- Exactly one OPEN row per (brand, key): the current value is unambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS brand_config_history_one_open_idx
  ON tenancy.brand_config_history (brand_id, config_key)
  WHERE valid_to IS NULL;

-- ── 2. RLS — brand isolation, FORCE ───────────────────────────────────────────
ALTER TABLE tenancy.brand_config_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.brand_config_history FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brand_config_history_isolation ON tenancy.brand_config_history;
CREATE POLICY brand_config_history_isolation ON tenancy.brand_config_history
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid)
  WITH CHECK (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- ── 3. Grants — APPEND-ONLY for the app (trigger does the close via DEFINER) ───
REVOKE ALL ON tenancy.brand_config_history FROM brain_app;
GRANT SELECT, INSERT ON tenancy.brand_config_history TO brain_app;

-- ── 4. Capture trigger — effective-date revenue-affecting brand config ─────────
-- SECURITY DEFINER so the "close the open row" UPDATE runs with the owner's rights (brain_app
-- holds INSERT-only). Still brand-scoped: we only ever touch rows for NEW.id.
CREATE OR REPLACE FUNCTION tenancy.capture_brand_config_history()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = tenancy, pg_temp
AS $$
DECLARE
  k     TEXT;
  newv  TEXT;
  oldv  TEXT;
  keys  TEXT[] := ARRAY['revenue_definition',
                        'cod_recognition_horizon_days',
                        'prepaid_recognition_horizon_days'];
BEGIN
  FOREACH k IN ARRAY keys LOOP
    -- Extract the key's value from NEW (and OLD on UPDATE) as text.
    EXECUTE format('SELECT ($1).%I::text', k) INTO newv USING NEW;
    IF TG_OP = 'UPDATE' THEN
      EXECUTE format('SELECT ($1).%I::text', k) INTO oldv USING OLD;
    ELSE
      oldv := NULL;
    END IF;

    -- On INSERT, seed history for every key. On UPDATE, only when the value actually changed.
    IF TG_OP = 'INSERT' OR newv IS DISTINCT FROM oldv THEN
      -- Close the currently-open row for this (brand, key), if any.
      UPDATE tenancy.brand_config_history
         SET valid_to = NOW()
       WHERE brand_id = NEW.id
         AND config_key = k
         AND valid_to IS NULL;
      -- Open the new effective row.
      INSERT INTO tenancy.brand_config_history (brand_id, config_key, config_value, valid_from)
      VALUES (NEW.id, k, newv, NOW());
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brand_config_history_capture ON tenancy.brand;
CREATE TRIGGER brand_config_history_capture
  AFTER INSERT OR UPDATE OF revenue_definition,
                            cod_recognition_horizon_days,
                            prepaid_recognition_horizon_days
  ON tenancy.brand
  FOR EACH ROW
  EXECUTE FUNCTION tenancy.capture_brand_config_history();

-- ── 5. Backfill the CURRENT config as the first open row for existing brands ───
-- (idempotent: skip a (brand,key) that already has an open row).
INSERT INTO tenancy.brand_config_history (brand_id, config_key, config_value, valid_from)
SELECT b.id, kv.k, kv.v, b.created_at
FROM tenancy.brand b
CROSS JOIN LATERAL (VALUES
  ('revenue_definition',               b.revenue_definition::text),
  ('cod_recognition_horizon_days',     b.cod_recognition_horizon_days::text),
  ('prepaid_recognition_horizon_days', b.prepaid_recognition_horizon_days::text)
) AS kv(k, v)
WHERE NOT EXISTS (
  SELECT 1 FROM tenancy.brand_config_history h
  WHERE h.brand_id = b.id AND h.config_key = kv.k AND h.valid_to IS NULL
);

-- ── Guard ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('tenancy.brand_config_history') IS NULL THEN
    RAISE EXCEPTION '0088 VIOLATION: tenancy.brand_config_history was not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname='tenancy' AND c.relname='brand_config_history' AND c.relrowsecurity AND c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION '0088 VIOLATION: brand_config_history must have FORCE RLS enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='brand_config_history_capture' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION '0088 VIOLATION: capture trigger not installed on tenancy.brand';
  END IF;
END $$;
