-- ============================================================================
-- 0050_connector_webhook_raw_archive.sql
-- feat-shopify-raw-webhook-archive (I-S02) — structure-visible, PII-safe webhook archive
-- ============================================================================
--
-- Persists the RAW webhook body SHAPE for every connector webhook topic so operators can
-- inspect "what did the provider actually send" WITHOUT exposing PII. Written by the Shopify
-- webhook handler's archiveRawWebhook() AFTER HMAC + brand resolution (authenticated +
-- tenant-scoped), fire-and-forget — it must never block or fail the 200 ack.
--
--   body_sha256   = sha256 of the ORIGINAL raw bytes (integrity + dedup key). Identical
--                   re-delivery → ON CONFLICT DO NOTHING (idempotent); a state change ships
--                   a different body → a new row, preserving the shape history.
--   redacted_body = redactShopifyPii(parsed) — every key/shape kept, PII LEAVES masked
--                   (I-S02). Raw email/phone/address NEVER reach the DB.
--
-- APPEND-ONLY by GRANT (mirrors bronze_events 0016 / realized_revenue_ledger 0018): brain_app
-- holds SELECT + INSERT only — NO UPDATE/DELETE. ENABLE + FORCE RLS, two-arg fail-closed
-- (I-S01 / NN-1); written under SET LOCAL app.current_brand_id in a txn (same pattern as
-- touchSyncStatus). Migration-time FORCE + NN-1 assertions mirror 0031 §G.
--
-- ADDITIVE ONLY (I-E02): CREATE TABLE/INDEX IF NOT EXISTS only.
-- ROLLBACK (migrate down): DROP TABLE IF EXISTS connector_webhook_raw_archive;
-- ============================================================================

CREATE TABLE IF NOT EXISTS connector_webhook_raw_archive (
  id             BIGSERIAL    PRIMARY KEY,
  brand_id       UUID         NOT NULL,                 -- RLS anchor (I-S01) / tenant key
  source         TEXT         NOT NULL,                 -- connector source (e.g. 'shopify')
  topic          TEXT         NOT NULL,                 -- webhook topic (e.g. 'orders/create')
  body_sha256    TEXT         NOT NULL,                 -- sha256 of the original raw bytes (integrity + dedup)
  received_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  correlation_id TEXT         NULL,
  redacted_body  JSONB        NOT NULL,                 -- PII-masked body shape (I-S02) — never raw PII
  -- Idempotent re-delivery: the same brand+topic+body hashes identically → DO NOTHING.
  CONSTRAINT connector_webhook_raw_archive_dedup UNIQUE (brand_id, topic, body_sha256)
);

-- Operator inspection by brand + recency.
CREATE INDEX IF NOT EXISTS connector_webhook_raw_archive_brand_recent_idx
  ON connector_webhook_raw_archive (brand_id, received_at DESC);

-- ENABLE + FORCE RLS — two-arg fail-closed (I-S01 / NN-1), verbatim 0031:50-56.
ALTER TABLE connector_webhook_raw_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_webhook_raw_archive FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_webhook_raw_archive_isolation ON connector_webhook_raw_archive
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- brain_app: SELECT + INSERT only — APPEND-ONLY archive (no UPDATE/DELETE — immutable shape history).
REVOKE ALL ON connector_webhook_raw_archive FROM brain_app;
GRANT SELECT, INSERT ON connector_webhook_raw_archive TO brain_app;
GRANT USAGE, SELECT ON SEQUENCE connector_webhook_raw_archive_id_seq TO brain_app;

-- ── Post-migration assertions (mirror 0031 §G) ────────────────────────────────

-- G-1: FORCE RLS (fail-closed under brain_app).
DO $$
DECLARE
  tbl_rowsecurity      BOOLEAN;
  tbl_forcerowsecurity BOOLEAN;
BEGIN
  SELECT relrowsecurity, relforcerowsecurity
  INTO tbl_rowsecurity, tbl_forcerowsecurity
  FROM pg_class
  WHERE relname = 'connector_webhook_raw_archive' AND relkind = 'r';

  IF NOT tbl_rowsecurity THEN
    RAISE EXCEPTION 'SEC-WRA-0050: connector_webhook_raw_archive does not have RLS enabled.';
  END IF;
  IF NOT tbl_forcerowsecurity THEN
    RAISE EXCEPTION 'SEC-WRA-0050: connector_webhook_raw_archive does not have FORCE RLS enabled.';
  END IF;
END
$$;

-- G-2: NN-1 two-arg current_setting check on the new table's policy.
DO $$
DECLARE
  bad_policy RECORD;
BEGIN
  FOR bad_policy IN
    SELECT schemaname, tablename, policyname, qual
    FROM pg_policies
    WHERE tablename = 'connector_webhook_raw_archive'
      AND (
        qual LIKE '%current_setting(''app.current_brand_id'')%'
        AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
        AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
      )
  LOOP
    RAISE EXCEPTION
      'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
      'Replace with two-arg form: current_setting(''app.current_brand_id'', TRUE).',
      bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
  END LOOP;
END
$$;

-- G-3: APPEND-ONLY — brain_app must NOT hold UPDATE/DELETE (mirror 0018 Assertion-2).
DO $$
DECLARE
  bad_grant TEXT;
BEGIN
  FOR bad_grant IN
    SELECT privilege_type
    FROM information_schema.role_table_grants
    WHERE table_name = 'connector_webhook_raw_archive'
      AND grantee = 'brain_app'
      AND privilege_type IN ('UPDATE', 'DELETE')
  LOOP
    RAISE EXCEPTION
      'APPEND-ONLY VIOLATION: brain_app holds "%" on connector_webhook_raw_archive '
      '(archive must be INSERT+SELECT only).', bad_grant;
  END LOOP;
END
$$;
