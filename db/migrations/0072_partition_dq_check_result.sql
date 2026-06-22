-- 0072_partition_dq_check_result.sql
--
-- DB-AUDIT C4b — partition the first unbounded append-only log table. audit.dq_check_result grows
-- per (brand × category × target × check-run) forever with no retention (18k rows already in dev).
-- This is the PROVEN, prod-safe twin-swap template for the unbounded log tables: build a RANGE-
-- partitioned twin (by checked_at), copy data, recreate indexes + RLS + grants, then atomically swap.
-- Retention becomes a partition DROP (O(1)) instead of a giant DELETE; queries prune by time.
--
-- PostgreSQL requires the partition key in every UNIQUE/PK → PK becomes (brand_id, result_id,
-- checked_at). Harmless: result_id is already unique; this only widens the key. The DQ writer INSERTs
-- fresh rows (no ON CONFLICT), so the wider PK changes nothing for writers.
--
-- PROD partition management: a monthly create-ahead + drop-old routine (pg_partman or a cron) maintains
-- partitions; here we seed a DEFAULT + the current/next months so dev + a fresh prod both work.
-- DEPLOY: this migration is self-contained (copy+swap in one txn); safe to run online for a log table.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE audit.dq_check_result_part (
  result_id  uuid                     NOT NULL DEFAULT gen_random_uuid(),
  brand_id   uuid                     NOT NULL,
  category   text                     NOT NULL,
  target     text                     NOT NULL,
  grade      text                     NOT NULL,
  score      numeric(5,4),
  observed   text                     NOT NULL,
  threshold  text                     NOT NULL,
  passing    boolean                  NOT NULL,
  checked_at timestamptz              NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, result_id, checked_at),
  CONSTRAINT dq_check_result_category_check CHECK (category = ANY (ARRAY['freshness','completeness','schema_validity','reconciliation'])),
  CONSTRAINT dq_check_result_grade_check    CHECK (grade = ANY (ARRAY['A+','A','B','C','D']))
) PARTITION BY RANGE (checked_at);

-- Time partitions (seed: current + next month) + a DEFAULT so no row is ever rejected.
CREATE TABLE audit.dq_check_result_p2026_06 PARTITION OF audit.dq_check_result_part
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE audit.dq_check_result_p2026_07 PARTITION OF audit.dq_check_result_part
  FOR VALUES FROM ('2026-07-01+00') TO ('2026-08-01+00');
CREATE TABLE audit.dq_check_result_pdefault PARTITION OF audit.dq_check_result_part DEFAULT;

-- ── 2. Copy existing data ────────────────────────────────────────────────────────────────────────
INSERT INTO audit.dq_check_result_part
  (result_id, brand_id, category, target, grade, score, observed, threshold, passing, checked_at)
SELECT result_id, brand_id, category, target, grade, score, observed, threshold, passing, checked_at
FROM audit.dq_check_result;

-- ── 3. Recreate the latest-lookup index + RLS + grants on the twin ─────────────────────────────────
CREATE INDEX idx_dq_check_result_latest ON audit.dq_check_result_part (brand_id, category, target, checked_at DESC);

ALTER TABLE audit.dq_check_result_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.dq_check_result_part FORCE ROW LEVEL SECURITY;
CREATE POLICY dq_check_result_isolation ON audit.dq_check_result_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON audit.dq_check_result_part FROM brain_app;
GRANT SELECT, INSERT ON audit.dq_check_result_part TO brain_app;  -- append-only results

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit.dq_check_result      RENAME TO dq_check_result_legacy;
ALTER TABLE audit.dq_check_result_part RENAME TO dq_check_result;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'audit.dq_check_result'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0072: dq_check_result must be PARTITIONED after swap'; END IF;
  SELECT count(*) INTO legacy_n FROM audit.dq_check_result_legacy;
  SELECT count(*) INTO new_n    FROM audit.dq_check_result;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0072: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;
END $$;

-- audit.dq_check_result_legacy is retained for a post-deploy verification window; DROP it in a
-- follow-up migration once the partitioned table is confirmed serving reads + writes.
