-- 0076_partition_decision_log.sql
--
-- DB-AUDIT C4b — partition the unbounded append-only recommendation decision log.
-- audit.decision_log grows per (brand × detector × decision-event) forever with no retention.
-- This applies the PROVEN, prod-safe twin-swap template (see 0072): build a RANGE-partitioned
-- twin (by created_at), copy data, recreate indexes + RLS + grants, then atomically swap.
-- Retention becomes a partition DROP (O(1)) instead of a giant DELETE; queries prune by time.
--
-- PostgreSQL requires the partition key in every UNIQUE/PK → PK becomes (decision_log_id,
-- created_at). Harmless: decision_log_id is already unique; this only widens the key. There is no
-- other UNIQUE constraint and no logical dedup to break. The recommendation writer (apps/core/.../
-- generate-recommendations.ts) does plain INSERTs (no ON CONFLICT), so the wider PK is a no-op for it.
--
-- PROD partition management: a monthly create-ahead + drop-old routine (pg_partman or a cron) maintains
-- partitions; here we seed a DEFAULT + the observed/current month so dev + a fresh prod both work.
-- DEPLOY: this migration is self-contained (copy+swap in one txn); safe to run online for a log table.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE audit.decision_log_part (
  decision_log_id   uuid                     NOT NULL DEFAULT gen_random_uuid(),
  brand_id          uuid                     NOT NULL,
  kind              text                     NOT NULL,
  recommendation_id uuid,
  actor             text                     NOT NULL,
  action            text                     NOT NULL,
  reason            text,
  payload           jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz              NOT NULL DEFAULT now(),
  PRIMARY KEY (decision_log_id, created_at)
) PARTITION BY RANGE (created_at);

-- Time partitions (seed: observed/current month) + a DEFAULT so no row is ever rejected.
CREATE TABLE audit.decision_log_p2026_06 PARTITION OF audit.decision_log_part
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE audit.decision_log_p2026_07 PARTITION OF audit.decision_log_part
  FOR VALUES FROM ('2026-07-01+00') TO ('2026-08-01+00');
CREATE TABLE audit.decision_log_pdefault PARTITION OF audit.decision_log_part DEFAULT;

-- ── 2. Copy existing data ────────────────────────────────────────────────────────────────────────
INSERT INTO audit.decision_log_part
  (decision_log_id, brand_id, kind, recommendation_id, actor, action, reason, payload, created_at)
SELECT decision_log_id, brand_id, kind, recommendation_id, actor, action, reason, payload, created_at
FROM audit.decision_log;

-- ── 3. Recreate RLS + grants on the twin ───────────────────────────────────────────────────────────
-- (the original table has only the PK index; no secondary indexes to recreate.)
ALTER TABLE audit.decision_log_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.decision_log_part FORCE ROW LEVEL SECURITY;
CREATE POLICY decision_log_isolation ON audit.decision_log_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON audit.decision_log_part FROM brain_app;
GRANT SELECT, INSERT ON audit.decision_log_part TO brain_app;  -- append-only audit log

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit.decision_log      RENAME TO decision_log_legacy;
ALTER TABLE audit.decision_log_part RENAME TO decision_log;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'audit.decision_log'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0076: decision_log must be PARTITIONED after swap'; END IF;
  SELECT count(*) INTO legacy_n FROM audit.decision_log_legacy;
  SELECT count(*) INTO new_n    FROM audit.decision_log;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0076: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;
END $$;

-- audit.decision_log_legacy is retained for a post-deploy verification window; DROP it in a
-- follow-up migration once the partitioned table is confirmed serving reads + writes.
