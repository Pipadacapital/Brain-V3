-- 0078_partition_tax_ledger.sql
--
-- DB-AUDIT C4b — RANGE-partition the append-only tax record ledger billing.tax_ledger. It accrues a
-- GST output/input record per (invoice | credit-note) forever with no retention. Same PROVEN twin-swap
-- template as 0072 (dq_check_result) / 0073 (realized_revenue_ledger): build a RANGE-partitioned twin,
-- copy data, recreate CHECKs + FKs + indexes + RLS + grants, then atomically swap. Retention/archival
-- becomes a partition DROP (O(1)) instead of a giant DELETE; reporting queries prune by time.
--
-- PARTITION KEY — created_at (timestamptz, NOT NULL DEFAULT now(); the wall-clock insert time). The
-- table also has a `period` char(7) column, but created_at is the natural append axis and carries a
-- default, so direct INSERTs that omit it (as the issue_invoice()/issue_credit_note() SECURITY DEFINER
-- functions do) keep working unchanged.
--
-- PostgreSQL requires the partition key in every UNIQUE/PK → the PK becomes (tax_record_id, created_at).
-- Harmless: tax_record_id is already unique; this only widens the key. The writer functions INSERT fresh
-- rows with no ON CONFLICT, so the wider PK changes nothing for writers.
--
-- Index names carry a `_p` suffix: the legacy table keeps the canonical names through the post-deploy
-- verify window; the partial FK-covering indexes are recreated by predicate+columns, not by name.
--
-- PROD partition management: a monthly create-ahead + drop-old routine (pg_partman or cron) maintains
-- partitions; here we seed the current month (the table is empty in dev) + a DEFAULT so dev + a fresh
-- prod both work. DEPLOY: self-contained (copy+swap in one txn); node-pg-migrate wraps it, or apply
-- with `psql -1`.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE billing.tax_ledger_part (
  tax_record_id  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  brand_id       uuid                     NOT NULL,
  invoice_id     uuid                     NOT NULL,
  regime         text                     NOT NULL,
  direction      text                     NOT NULL,
  rate_bps       integer                  NOT NULL,
  taxable_minor  bigint                   NOT NULL,
  tax_minor      bigint                   NOT NULL,
  period         character(7)             NOT NULL,
  sac_hsn_code   text                     NOT NULL,
  created_at     timestamptz              NOT NULL DEFAULT now(),
  credit_note_id uuid,
  PRIMARY KEY (tax_record_id, created_at),
  CONSTRAINT tax_ledger_direction_check CHECK (direction = ANY (ARRAY['input'::text, 'output'::text])),
  CONSTRAINT tax_ledger_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES billing.invoice (invoice_id),
  CONSTRAINT tax_ledger_credit_note_fk  FOREIGN KEY (credit_note_id) REFERENCES billing.credit_note (credit_note_id)
) PARTITION BY RANGE (created_at);

-- Time partitions (seed: current month — table is empty in dev) + a DEFAULT so no row is ever rejected.
CREATE TABLE billing.tax_ledger_p2026_06 PARTITION OF billing.tax_ledger_part
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE billing.tax_ledger_pdefault PARTITION OF billing.tax_ledger_part DEFAULT;

-- ── 2. Copy existing data ────────────────────────────────────────────────────────────────────────
INSERT INTO billing.tax_ledger_part
  (tax_record_id, brand_id, invoice_id, regime, direction, rate_bps, taxable_minor, tax_minor,
   period, sac_hsn_code, created_at, credit_note_id)
SELECT
  tax_record_id, brand_id, invoice_id, regime, direction, rate_bps, taxable_minor, tax_minor,
  period, sac_hsn_code, created_at, credit_note_id
FROM billing.tax_ledger;

-- ── 3. Recreate FK-covering partial indexes + RLS + grants on the twin ─────────────────────────────
-- `_p` names avoid colliding with the legacy table's canonical index names during the verify window.
CREATE INDEX idx_tax_ledger_invoice_id_p
  ON billing.tax_ledger_part (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX idx_tax_ledger_credit_note_id_p
  ON billing.tax_ledger_part (credit_note_id) WHERE credit_note_id IS NOT NULL;

ALTER TABLE billing.tax_ledger_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.tax_ledger_part FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_ledger_isolation ON billing.tax_ledger_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON billing.tax_ledger_part FROM brain_app;
GRANT SELECT ON billing.tax_ledger_part TO brain_app;  -- read-only: writes go through SECURITY DEFINER fns

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE billing.tax_ledger      RENAME TO tax_ledger_legacy;
ALTER TABLE billing.tax_ledger_part RENAME TO tax_ledger;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'billing.tax_ledger'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0078: tax_ledger must be PARTITIONED after swap'; END IF;
  SELECT count(*) INTO legacy_n FROM billing.tax_ledger_legacy;
  SELECT count(*) INTO new_n    FROM billing.tax_ledger;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0078: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;
END $$;

-- billing.tax_ledger_legacy is retained for a post-deploy verification window; DROP it in a follow-up
-- migration once the partitioned table is confirmed serving reads + writes in prod.
