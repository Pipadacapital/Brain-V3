-- ============================================================================
-- 0046_gst_split_and_credit_notes.sql
-- feat-billing-cgst-sgst-credit-notes (P1) — GST regime split + immutable credit notes
-- ============================================================================
--
-- Two GST-compliance refinements on the issued-invoice slice (0042):
--
--   1. CGST/SGST split. Indian GST is intra-state (CGST+SGST, each half-rate) vs inter-state
--      (IGST, full rate) by place of supply. issue_invoice() now records the split in the invoice
--      `tax` JSONB AND writes the tax_ledger by component (two rows 'cgst'+'sgst' intra-state, one
--      'igst' row inter-state) — so GSTR-1 output tax is correct. The split amounts are computed
--      authoritatively by the caller (gst.ts, exact: cgst+sgst == total) and passed in.
--
--   2. Credit notes. An issued invoice is IMMUTABLE (0042) — corrections are credit notes, never
--      edits. A credit_note is itself immutable, gapless-numbered per (legal_entity, FY) on its own
--      series, references the invoice it corrects, and posts REVERSING (negative) tax_ledger rows so
--      output GST nets down. Partial + multiple credit notes allowed, capped at the invoice total.
--
-- ADDITIVE-leaning (I-E02): one in-place function REPLACE (issue_invoice gains 3 split params), one
-- nullable column add, plus new tables/functions. ROLLBACK:
--   DROP FUNCTION IF EXISTS issue_credit_note(uuid,uuid,text,bigint,integer,bigint,text,text,bigint,bigint,bigint);
--   DROP TABLE IF EXISTS credit_note, credit_note_number_counter;
--   ALTER TABLE tax_ledger DROP COLUMN IF EXISTS credit_note_id;
--   (issue_invoice's prior 13-arg form must be restored from 0042.)

-- ── 1. tax_ledger gains a credit-note backref (output reversals point at the CN) ──
ALTER TABLE tax_ledger ADD COLUMN IF NOT EXISTS credit_note_id UUID NULL;

-- ── 2. issue_invoice() — now records the CGST/SGST/IGST split ──────────────────
-- The 0042 form summed GST into one tax_ledger row tagged by regime. This version takes the
-- caller-computed split (cgst/sgst/igst minor) and writes the invoice `tax` JSONB + tax_ledger by
-- component. Signature CHANGES (3 new params), so DROP the old form first (no overload ambiguity).
DROP FUNCTION IF EXISTS issue_invoice(uuid, char, text, text, text, text, integer, bigint, text, integer, bigint, text, text);

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
  p_metric_version  TEXT,
  p_cgst_minor      BIGINT,
  p_sgst_minor      BIGINT,
  p_igst_minor      BIGINT
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
  v_half_bps INTEGER := p_tax_rate_bps / 2;
BEGIN
  SELECT metered_gmv_minor, currency_code
    INTO v_basis, v_currency
    FROM gmv_meter_snapshot
   WHERE brand_id = p_brand_id AND billing_period = p_period;
  IF v_basis IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'not_sealed');
  END IF;

  SELECT invoice_id, invoice_number INTO v_id, v_num
    FROM invoice WHERE brand_id = p_brand_id AND billing_period = p_period;
  IF v_id IS NOT NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'already_issued',
      'invoice_id', v_id, 'invoice_number', v_num);
  END IF;

  v_total := p_fee_minor + p_tax_minor;

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
      'cgst_minor', p_cgst_minor, 'sgst_minor', p_sgst_minor, 'igst_minor', p_igst_minor,
      'seller_gstin', p_seller_gstin, 'place_of_supply', p_place_of_supply),
    'issued', p_seller_gstin, p_place_of_supply);

  INSERT INTO invoice_line (invoice_id, line_no, brand_id, line_type, description,
    basis_gmv_minor, rate_bps, metric_definition_version, source_billing_period,
    sac_hsn_code, taxable_minor, tax_rate_bps, tax_minor, amount_minor)
  VALUES (v_id, 1, p_brand_id, 'platform_fee', 'Brain platform fee on realized GMV',
    v_basis, p_rate_bps, p_metric_version, p_period,
    p_sac, p_fee_minor, p_tax_rate_bps, p_tax_minor, v_total);

  -- tax_ledger by component: intra-state ⇒ cgst + sgst rows; inter-state ⇒ one igst row.
  IF p_regime = 'cgst_sgst' THEN
    INSERT INTO tax_ledger (brand_id, invoice_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, v_id, 'cgst', 'output', v_half_bps, p_fee_minor, p_cgst_minor, p_period, p_sac),
           (p_brand_id, v_id, 'sgst', 'output', v_half_bps, p_fee_minor, p_sgst_minor, p_period, p_sac);
  ELSE
    INSERT INTO tax_ledger (brand_id, invoice_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, v_id, 'igst', 'output', p_tax_rate_bps, p_fee_minor, p_igst_minor, p_period, p_sac);
  END IF;

  RETURN jsonb_build_object('issued', true, 'invoice_id', v_id, 'invoice_number', v_num,
    'fee_minor', p_fee_minor, 'tax_minor', p_tax_minor, 'total_minor', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION issue_invoice(uuid, char, text, text, text, text, integer, bigint, text, integer, bigint, text, text, bigint, bigint, bigint) TO brain_app;

-- ── 3. credit_note number series (platform-shared; not brand-scoped) ───────────
-- A SEPARATE gapless series from invoices (GST allows distinct CN numbering). Touched ONLY by
-- issue_credit_note() under a row lock — no brain_app grant.
CREATE TABLE IF NOT EXISTS credit_note_number_counter (
  legal_entity TEXT   NOT NULL,
  fy           TEXT   NOT NULL,
  next_seq     BIGINT NOT NULL DEFAULT 1,
  PRIMARY KEY (legal_entity, fy)
);

-- ── 4. credit_note (issued = immutable, references the corrected invoice) ──────
CREATE TABLE IF NOT EXISTS credit_note (
  credit_note_id     UUID        NOT NULL DEFAULT gen_random_uuid(),
  brand_id           UUID        NOT NULL,            -- tenant key / RLS anchor (I-S01)
  invoice_id         UUID        NOT NULL REFERENCES invoice(invoice_id),
  billing_period     CHAR(7)     NOT NULL,
  legal_entity       TEXT        NOT NULL,
  fy                 TEXT        NOT NULL,
  credit_note_number TEXT        NOT NULL,            -- gapless per (legal_entity, fy), CN series
  currency_code      CHAR(3)     NOT NULL,
  reason             TEXT        NOT NULL,            -- GST requires a stated reason
  taxable_minor      BIGINT      NOT NULL,            -- credited taxable value (positive magnitude)
  tax_minor          BIGINT      NOT NULL,            -- credited GST (positive magnitude)
  total_minor        BIGINT      NOT NULL,            -- taxable + tax (positive magnitude)
  regime             TEXT        NOT NULL,            -- 'igst' | 'cgst_sgst'
  tax                JSONB       NOT NULL,            -- {regime, rate_bps, cgst_minor, sgst_minor, igst_minor, sac_hsn_code}
  sac_hsn_code       TEXT        NOT NULL,
  tax_rate_bps       INTEGER     NOT NULL,
  seller_gstin       TEXT        NOT NULL,
  place_of_supply    TEXT        NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'issued' CHECK (status IN ('issued')),
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (credit_note_id),
  UNIQUE (legal_entity, fy, credit_note_number)
);

ALTER TABLE credit_note ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_note FORCE ROW LEVEL SECURITY;
CREATE POLICY credit_note_isolation ON credit_note
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);
REVOKE ALL ON credit_note FROM brain_app;
GRANT SELECT ON credit_note TO brain_app;   -- reads only; issuance is via issue_credit_note()

-- backref FK now that credit_note exists
ALTER TABLE tax_ledger DROP CONSTRAINT IF EXISTS tax_ledger_credit_note_fk;
ALTER TABLE tax_ledger ADD CONSTRAINT tax_ledger_credit_note_fk
  FOREIGN KEY (credit_note_id) REFERENCES credit_note(credit_note_id);

-- ── 5. issue_credit_note() — atomic, gapless, capped at the invoice total ──────
-- Validates the invoice belongs to the brand, that cumulative credits will not exceed the invoice
-- total, allocates a gapless CN number, writes the immutable credit_note + REVERSING tax_ledger
-- rows (negative tax, pointing at the CN). SECURITY DEFINER (same rationale as issue_invoice).
CREATE OR REPLACE FUNCTION issue_credit_note(
  p_brand_id     UUID,
  p_invoice_id   UUID,
  p_reason       TEXT,
  p_taxable_minor BIGINT,
  p_tax_rate_bps INTEGER,
  p_tax_minor    BIGINT,
  p_regime       TEXT,
  p_sac          TEXT,
  p_cgst_minor   BIGINT,
  p_sgst_minor   BIGINT,
  p_igst_minor   BIGINT
) RETURNS JSONB
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
AS $$
DECLARE
  v_inv      invoice%ROWTYPE;
  v_credited BIGINT;
  v_total    BIGINT := p_taxable_minor + p_tax_minor;
  v_cn_id    UUID;
  v_seq      BIGINT;
  v_num      TEXT;
  v_half_bps INTEGER := p_tax_rate_bps / 2;
BEGIN
  IF p_taxable_minor < 0 OR p_tax_minor < 0 OR v_total <= 0 THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'invalid_amount');
  END IF;

  SELECT * INTO v_inv FROM invoice WHERE invoice_id = p_invoice_id AND brand_id = p_brand_id;
  IF v_inv.invoice_id IS NULL THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'invoice_not_found');
  END IF;

  -- Cap: cumulative credit notes must not exceed the invoice total (no over-crediting).
  SELECT COALESCE(SUM(total_minor), 0) INTO v_credited FROM credit_note WHERE invoice_id = p_invoice_id;
  IF v_credited + v_total > v_inv.total_minor THEN
    RETURN jsonb_build_object('issued', false, 'reason', 'exceeds_invoice',
      'already_credited_minor', v_credited, 'invoice_total_minor', v_inv.total_minor);
  END IF;

  INSERT INTO credit_note_number_counter (legal_entity, fy, next_seq)
  VALUES (v_inv.legal_entity, v_inv.fy, 1)
  ON CONFLICT (legal_entity, fy) DO NOTHING;

  SELECT next_seq INTO v_seq
    FROM credit_note_number_counter
   WHERE legal_entity = v_inv.legal_entity AND fy = v_inv.fy
     FOR UPDATE;
  UPDATE credit_note_number_counter
     SET next_seq = v_seq + 1
   WHERE legal_entity = v_inv.legal_entity AND fy = v_inv.fy;

  v_num := v_inv.legal_entity || '/' || v_inv.fy || '/CN/' || lpad(v_seq::text, 6, '0');
  v_cn_id := gen_random_uuid();

  INSERT INTO credit_note (credit_note_id, brand_id, invoice_id, billing_period, legal_entity, fy,
    credit_note_number, currency_code, reason, taxable_minor, tax_minor, total_minor, regime, tax,
    sac_hsn_code, tax_rate_bps, seller_gstin, place_of_supply)
  VALUES (v_cn_id, p_brand_id, p_invoice_id, v_inv.billing_period, v_inv.legal_entity, v_inv.fy,
    v_num, v_inv.currency_code, p_reason, p_taxable_minor, p_tax_minor, v_total, p_regime,
    jsonb_build_object('regime', p_regime, 'rate_bps', p_tax_rate_bps, 'sac_hsn_code', p_sac,
      'cgst_minor', p_cgst_minor, 'sgst_minor', p_sgst_minor, 'igst_minor', p_igst_minor),
    p_sac, p_tax_rate_bps, v_inv.seller_gstin, v_inv.place_of_supply);

  -- Reversing (negative) output tax rows, pointing at the CN.
  IF p_regime = 'cgst_sgst' THEN
    INSERT INTO tax_ledger (brand_id, invoice_id, credit_note_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, p_invoice_id, v_cn_id, 'cgst', 'output', v_half_bps, -p_taxable_minor, -p_cgst_minor, v_inv.billing_period, p_sac),
           (p_brand_id, p_invoice_id, v_cn_id, 'sgst', 'output', v_half_bps, -p_taxable_minor, -p_sgst_minor, v_inv.billing_period, p_sac);
  ELSE
    INSERT INTO tax_ledger (brand_id, invoice_id, credit_note_id, regime, direction, rate_bps, taxable_minor, tax_minor, period, sac_hsn_code)
    VALUES (p_brand_id, p_invoice_id, v_cn_id, 'igst', 'output', p_tax_rate_bps, -p_taxable_minor, -p_igst_minor, v_inv.billing_period, p_sac);
  END IF;

  RETURN jsonb_build_object('issued', true, 'credit_note_id', v_cn_id, 'credit_note_number', v_num,
    'taxable_minor', p_taxable_minor, 'tax_minor', p_tax_minor, 'total_minor', v_total);
END;
$$;

GRANT EXECUTE ON FUNCTION issue_credit_note(uuid, uuid, text, bigint, integer, bigint, text, text, bigint, bigint, bigint) TO brain_app;

-- ── 6. Assertions ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_secdef boolean;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'credit_note'
       AND relrowsecurity IS TRUE AND relforcerowsecurity IS TRUE
  ) THEN
    RAISE EXCEPTION 'RLS GUARD (0046): credit_note must have RLS ENABLED + FORCED.';
  END IF;

  SELECT p.prosecdef INTO v_secdef FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'issue_credit_note';
  IF v_secdef IS NULL THEN
    RAISE EXCEPTION 'MIGRATION ASSERTION (0046): issue_credit_note() not found.';
  END IF;
  IF v_secdef IS NOT TRUE THEN
    RAISE EXCEPTION 'ISSUANCE GUARD (0046): issue_credit_note() must be SECURITY DEFINER.';
  END IF;
END
$$;

-- Immutability: brain_app must NOT hold write grants on credit_note.
DO $$
DECLARE
  v_bad text;
BEGIN
  SELECT string_agg(privilege_type, ', ') INTO v_bad
    FROM information_schema.role_table_grants
   WHERE table_name = 'credit_note' AND grantee = 'brain_app'
     AND privilege_type IN ('UPDATE', 'DELETE', 'INSERT');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'IMMUTABILITY VIOLATION (0046): brain_app holds write grants on credit_note [%].', v_bad;
  END IF;
END
$$;
