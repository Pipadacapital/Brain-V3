-- 0077_partition_send_log.sql
--
-- DB-AUDIT C4b — partition the unbounded append-only notification send log. audit.send_log records
-- every outbound notification attempt + gate decision (one row per send, forever, no retention). It is
-- a clear unbounded log-growth table. This applies the PROVEN, prod-safe twin-swap template (mirrors
-- 0072): build a RANGE-partitioned twin (by created_at), copy data, recreate indexes + RLS + grants,
-- then atomically swap. Retention becomes a partition DROP (O(1)) instead of a giant DELETE; time
-- queries (idx_send_log_brand_recent) prune by partition.
--
-- PostgreSQL requires the partition key in every UNIQUE/PK → the surrogate PK widens from (id) to
-- (id, created_at). Harmless: `id` is a GENERATED ALWAYS AS IDENTITY bigint that stays unique; this
-- only appends the partition key. The send writer INSERTs fresh rows (no ON CONFLICT) and the
-- pending-window flusher UPDATEs by (brand_id, id) — neither depends on the PK shape, so the widening
-- changes nothing for writers. No table has a logical/idempotency UNIQUE that would break.
--
-- brain_app retains SELECT + INSERT (append) + UPDATE — the UPDATE is required for the
-- pending_window → released/blocked status transition driven by pending-window.handler.ts.
--
-- PROD partition management: a monthly create-ahead + drop-old routine (pg_partman or a cron) maintains
-- partitions; here we seed a DEFAULT + the current month so dev + a fresh prod both work (table is
-- empty in dev — the DEFAULT partition handles 0 rows).
-- DEPLOY: this migration is self-contained (copy+swap in one txn); safe to run online for a log table.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE audit.send_log_part (
  id                bigint                   GENERATED ALWAYS AS IDENTITY,
  brand_id          uuid                     NOT NULL,
  subject_hash      text,
  channel           text                     NOT NULL,
  notification_type text                     NOT NULL,
  status            text                     NOT NULL,
  blocked_reason    text,
  release_after     timestamptz,
  correlation_id    text,
  created_at        timestamptz              NOT NULL DEFAULT now(),
  updated_at        timestamptz              NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at),
  CONSTRAINT send_log_status_check CHECK (status = ANY (ARRAY['attempted','sent','failed','blocked','pending_window','released']))
) PARTITION BY RANGE (created_at);

-- Time partitions (seed: current month) + a DEFAULT so no row is ever rejected.
CREATE TABLE audit.send_log_p2026_06 PARTITION OF audit.send_log_part
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE audit.send_log_pdefault PARTITION OF audit.send_log_part DEFAULT;

-- ── 2. Copy existing data ────────────────────────────────────────────────────────────────────────
-- OVERRIDING SYSTEM VALUE: preserve the original identity `id` values (GENERATED ALWAYS).
INSERT INTO audit.send_log_part
  (id, brand_id, subject_hash, channel, notification_type, status,
   blocked_reason, release_after, correlation_id, created_at, updated_at)
OVERRIDING SYSTEM VALUE
SELECT id, brand_id, subject_hash, channel, notification_type, status,
       blocked_reason, release_after, correlation_id, created_at, updated_at
FROM audit.send_log;

-- ── 3. Recreate non-PK indexes + RLS + grants on the twin (non-PK names get a _p suffix) ───────────
CREATE INDEX idx_send_log_brand_recent_p ON audit.send_log_part (brand_id, created_at DESC);
CREATE INDEX idx_send_log_pending_window_p ON audit.send_log_part (brand_id, status, release_after)
  WHERE status = 'pending_window';

ALTER TABLE audit.send_log_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.send_log_part FORCE ROW LEVEL SECURITY;
CREATE POLICY send_log_isolation ON audit.send_log_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON audit.send_log_part FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON audit.send_log_part TO brain_app;  -- append + pending_window status transition

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit.send_log      RENAME TO send_log_legacy;
ALTER TABLE audit.send_log_part RENAME TO send_log;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'audit.send_log'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0077: send_log must be PARTITIONED after swap'; END IF;
  SELECT count(*) INTO legacy_n FROM audit.send_log_legacy;
  SELECT count(*) INTO new_n    FROM audit.send_log;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0077: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;
END $$;

-- audit.send_log_legacy is retained for a post-deploy verification window; DROP it in a follow-up
-- migration once the partitioned table is confirmed serving reads + writes.
