-- ============================================================================
-- 0042_invoice_issuance.sql
-- feat-billing-invoice-issuance (P1) — issued GST invoice + tax ledger (doc 08/04 §F.1.5)
-- ============================================================================
--
-- The final billing slice: turn a sealed period's inspectable bill into an ISSUED invoice —
-- a legal document with a GAPLESS invoice_number per legal-entity/FY, GST (SAC/HSN + tax_ledger),
-- and self-explaining invoice_line provenance (basis_gmv_minor, rate_bps, source period). Once
-- issued it is IMMUTABLE — corrections are credit notes (a follow-up slice), never edits.
--
-- WHY a SECURITY DEFINER function does the issuance: gapless numbering requires locking a shared
-- per-(legal_entity, FY) counter and writing invoice + invoice_line + tax_ledger ATOMICALLY in
-- ONE transaction. @brain/db wraps each query() in its own transaction, so a multi-statement
-- atomic+locking flow cannot be expressed across query() calls — it must live in one DB function
-- (mirrors resolve_merge_review, 0039). The function is strictly scoped to the passed brand_id.
--
-- IMMUTABILITY: brain_app gets SELECT ONLY on invoice/invoice_line/tax_ledger (reads); all writes
-- go through issue_invoice() (the definer). The shared counter has NO brain_app grant at all.
-- RLS: ENABLE + FORCE on the three brand-scoped tables; two-arg fail-closed policy (NN-1).
--
-- ADDITIVE ONLY (I-E02). ROLLBACK:
--   DROP FUNCTION IF EXISTS issue_invoice(uuid,char,text,text,text,text,int,bigint,text,int,bigint,text,text);
--   DROP TABLE IF EXISTS tax_ledger, invoice_line, invoice, invoice_number_counter;

-- ── 1. Gapless number counter (platform-shared; NOT brand-scoped) ─────────────
-- One row per (legal_entity, FY). Touched ONLY by issue_invoice() under a row lock — no
-- brain_app grant, so it can never be read/written outside the issuance function.
CREATE TABLE IF NOT EXISTS invoice_number_counter (
  legal_entity TEXT   NOT NULL,
  fy           TEXT   NOT NULL,            -- Indian financial year, e.g. '2098-2099'
  next_seq     BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (legal_entity, fy)
);

-- ── 2. invoice (issued = immutable) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice (
  invoice_id       UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id         UUID        NOT NULL,            -- tenant key / RLS anchor (I-S01)
  billing_period   CHAR(7)     NOT NULL             -- the sealed gmv_meter_snapshot reference (provenance)
                     CHECK (billing_period ~ '^\d{4}-\d{2}$'),
  legal_entity     TEXT        NOT NULL,
  fy               TEXT        NOT NULL,
  invoice_number   TEXT        NOT NULL,            -- gapless per (legal_entity, fy)
  currency_code    CHAR(3)     NOT NULL,
  basis_gmv_minor  BIGINT      NOT NULL,            -- the sealed realized-GMV basis (I-S07)
  rate_bps         INTEGER     NOT NULL,
  fee_minor        BIGINT      NOT NULL,            -- platform fee (taxable value)
  tax_minor        BIGINT      NOT NULL,            -- total GST
  total_minor      BIGINT      NOT NULL,            -- fee + tax
  tax              JSONB       NOT NULL,            -- GST breakdown {regime, rate_bps, sac_hsn_code, ...}
  status           TEXT        NOT NULL DEFAULT 'issued'
                     CHECK (status IN ('issued', 'void')),
  seller_gstin     TEXT        NOT NULL,
  place_of_supply  TEXT        NOT NULL,
  issued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (invoice_id),
  UNIQUE (brand_id, billing_period),                -- one invoice per sealed period (idempotency)
  UNIQUE (legal_entity, fy, invoice_number)         -- gapless number is unique per entity/FY
);

ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_isolation ON invoice
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON invoice FROM brain_app;
GRANT SELECT ON invoice TO brain_app;   -- reads only; issuance is via issue_invoice()

-- ── 3. invoice_line (self-explaining provenance) ──────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_line (
  invoice_id                UUID    NOT NULL REFERENCES invoice(invoice_id),
  line_no                   INTEGER NOT NULL,
  brand_id                  UUID    NOT NULL,        -- RLS anchor (denormalized)
  line_type                 TEXT    NOT NULL,        -- e.g. 'platform_fee'
  description               TEXT    NOT NULL,
  basis_gmv_minor           BIGINT  NOT NULL,
  rate_bps                  INTEGER NOT NULL,
  metric_definition_version TEXT    NOT NULL,        -- the metric seam version (provenance)
  source_billing_period     CHAR(7) NOT NULL,        -- the sealed snapshot reference (our period-keyed analog of source_snapshot_id)
  sac_hsn_code              TEXT    NOT NULL,
  taxable_minor             BIGINT  NOT NULL,
  tax_rate_bps              INTEGER NOT NULL,
  tax_minor                 BIGINT  NOT NULL,
  amount_minor              BIGINT  NOT NULL,        -- taxable + tax (line total)
  PRIMARY KEY (invoice_id, line_no)
);

ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;
CREATE POLICY invoice_line_isolation ON invoice_line
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON invoice_line FROM brain_app;
GRANT SELECT ON invoice_line TO brain_app;

-- ── 4. tax_ledger (GST output records) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tax_ledger (
  tax_record_id UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id      UUID        NOT NULL,                -- RLS anchor
  invoice_id    UUID        NOT NULL REFERENCES invoice(invoice_id),
  regime        TEXT        NOT NULL,                -- 'igst' | 'cgst_sgst'
  direction     TEXT        NOT NULL CHECK (direction IN ('input', 'output')),
  rate_bps      INTEGER     NOT NULL,
  taxable_minor BIGINT      NOT NULL,
  tax_minor     BIGINT      NOT NULL,
  period        CHAR(7)     NOT NULL,
  sac_hsn_code  TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tax_record_id)
);

ALTER TABLE tax_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_ledger_isolation ON tax_ledger
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON tax_ledger FROM brain_app;
GRANT SELECT ON tax_ledger TO brain_app;

-- ── 5. issue_invoice() — atomic gapless issuance (SECURITY DEFINER) ───────────
-- Reads the sealed basis/currency from gmv_meter_snapshot (authoritative). Idempotent on
-- (brand_id, billing_period): a re-issue returns the existing invoice WITHOUT consuming a number.
-- The money figures (fee/tax) are computed authoritatively by the caller (billing module, via
-- @brain/money D-7 rounding — the same path as the inspectable bill, so preview == issued).
CREATE OR REPLACE FUNCTION issue_invoice(
  p_brand_id        UUID,
  p_period          CHAR(7),
  p_legal_entity    TEXT,
  p_fy              TEXT,
  p_seller_gstin    TEXT,
  p_place_of_supply TEXT,
  p_rate_bps        INTEGER,
  p_fee_minor       BIGINT,
  p_sac             TEXT,
  p_tax_rate_bps    INTEGER,
  p_tax_minor       BIGINT,
  p_regime          TEXT,
  p_metric_version  TEXT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_basis    BIGINT;
  v_currency CHAR(3);
  v_id       UUID;
  v_num      TEXT;
  v_seq      BIGINT;
  v_total    BIGINT;
BEGIN
  -- Basis from the sealed snapshot — none → nothing to bill (honest).
  SELECT metered_gmv_minor, currency_code
    INTO v_basis, v_currency
    FROM gmv_meter_snapshot
   WHERE brand_id = p_brand_id AND billing_period = p_period;
  IF v_basis IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not_sealed');
  END IF;

  -- Idempotency: an invoice already exists for this period → return it, consume NO number.
  SELECT invoice_id, invoice_number INTO v_id, v_num
    FROM invoice WHERE brand_id = p_brand_id AND billing_period = p_period;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'already_issued',
      'invoice_id', v_id, 'invoice_number', v_num);
  END IF;

  v_total := p_fee_minor + p_tax_minor;

  -- Gapless number: ensure the counter row exists, then lock + allocate + advance.
  INSERT INTO invoice_number_counter (legal_entity, fy, next_seq)
  VALUES (p_legal_entity, p_fy, 1)
  ON CONFLICT (legal_entity, fy) DO NOTHING;

  SELECT next_seq INTO v_seq
    FROM invoice_number_counter
   WHERE legal_entity = p_legal_entity AND fy = p_fy
     FOR UPDATE;

  UPDATE invoice_number_counter
     SET next_seq = v_seq + 1
   WHERE legal_entity = p_legal_entity AND fy = p_fy;

  v_num := p_legal_entity || '/' || p_fy || '/' || lpad(v_seq::text, 6, '0');
  v_id := gen_random_uuid();

  INSERT INTO invoice (invoice_id, brand_id, billing_period, legal_entity, fy, invoice_number,
    currency_code, basis_gmv_minor, rate_bps, fee_minor, tax_minor, total_minor, tax,
    status, seller_gstin, place_of_supply)
  VALUES (v_id, p_brand_id, p_period, p_legal_entity, p_fy, v_num,
    v_currency, v_basis, p_rate_bps, p_fee_minor, p_tax_minor, v_total,
    jsonb_build_object('regime', p_regime, 'rate_bps', p_tax_rate_bps, 'sac_hsn_code', p_sac,
      'taxable_minor', p_fee_minor, 'tax_minor', p_tax_minor,
      'seller_gstin', p_seller_gstin, 'place_of_supply', p_place_of_supply),
    'issued', p_seller_gstin, p_place_of_supply);

  INSERT INTO invoice_line (invoice_id, line_no, brand_id, line_type, description,
    basis_gmv_minor, rate_bps, metric_definition_version, source_billing_period,
    sac_hsn_code, taxable_minor, tax_rate_bps, tax_minor, amount_minor)
  VALUES (v_id, 1, p_brand_id, 'platform_fee', 'Brain platform fee on realized GMV',
    v_basis, p_rate_bps, p_metric_version, p_period,
    p_sac, p_fee_minor, p_tax_rate_bps, p_tax_minor, v_total);

  INSERT INTO tax_ledger (brand_id, invoice_id, regime, direction, rate_bps, taxable_minor,
    tax_minor, period, sac_hsn_code)
  VALUES (p_brand_id, v_id, p_regime, 'output', p_tax_rate_bps, p_fee_minor,
    p_tax_minor, p_period, p_sac);

  RETURN jsonb_build_object('issued', true, 'invoice_id', v_id, 'invoice_number', v_num,
    'fee_minor', p_fee_minor, 'tax_minor', p_tax_minor, 'total_minor', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION issue_invoice(uuid, char, text, text, text, text, integer, bigint, text, integer, bigint, text, text) TO brain_app;

-- ── 6. Migration-time assertions ──────────────────────────────────────────────

-- Assertion-1: RLS ENABLED + FORCED on all three brand-scoped tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['invoice', 'invoice_line', 'tax_ledger'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class
       WHERE relname = t AND relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE
    ) THEN
      RAISE EXCEPTION 'RLS GUARD (0042): % must have ROW LEVEL SECURITY ENABLED + FORCED.', t;
    END IF;
  END LOOP;
END
$$;

-- Assertion-2: issue_invoice() is SECURITY DEFINER with a pinned search_path.
DO $$
DECLARE
  v_secdef boolean;
  v_cfg    text;
BEGIN
  SELECT p.prosecdef, array_to_string(p.proconfig, ',')
    INTO v_secdef, v_cfg
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'issue_invoice';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0042): issue_invoice() not found.';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'ISSUANCE GUARD (0042): issue_invoice() must be SECURITY DEFINER.';
  END IF;
  IF v_cfg IS NULL OR v_cfg NOT LIKE '%search_path=public%' THEN
    RAISE EXCEPTION 'ISSUANCE GUARD (0042): issue_invoice() must pin SET search_path = public.';
  END IF;
END
$$;

-- Assertion-3: issued invoices are immutable — brain_app must NOT hold UPDATE/DELETE/INSERT.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(table_name || ':' || privilege_type, ', ') INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_name IN ('invoice', 'invoice_line', 'tax_ledger')
     AND grantee = 'brain_app'
     AND privilege_type IN ('UPDATE', 'DELETE', 'INSERT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABILITY VIOLATION (0042): brain_app holds write grants [%]. '
      'Issued invoices are immutable — SELECT only; issuance is via issue_invoice().', v_bad;
  END IF;
END
$$;
