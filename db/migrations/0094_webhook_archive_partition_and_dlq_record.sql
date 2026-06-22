-- 0094_webhook_archive_partition_and_dlq_record.sql
--
-- GAP: webhook-archive-partition-dlq-pg (HIGH) — two additions:
--
-- PART A — Partition connectors.connector_webhook_raw_archive by RANGE(received_at).
--   The table is an unbounded high-cardinality append-only heap that will receive rows
--   from ALL providers in the Phase-2 generic webhook pipeline. Without partitioning:
--   • retention/archival is an O(n) DELETE; partition DROP is O(1).
--   • time-scoped operator queries can't prune; every scan is a full-table-scan.
--   Uses the proven twin-swap template (0075 identity_audit / 0073 ledger).
--   The DEDUP UNIQUE (brand_id, topic, body_sha256) stays intact on the twin.
--   PARTITION KEY: received_at (NOT NULL DEFAULT now() — partition routing always
--   satisfied). PK widens to (brand_id, id, received_at) per PG's partitioned-table
--   uniqueness rule (PK must include the partition key column).
--   Children are BORN-SECURE: REVOKE ALL from brain_app + FORCE RLS + isolation policy.
--   The maintain_time_partitions() catalog routine auto-discovers this table and keeps
--   children born-secure going forward (0084 updated that routine to do so).
--
-- PART B — Create connectors.connector_dlq_record: a queryable, partitioned, brand-scoped
--   forensic store for Kafka dead-letters.
--   The DLQ is currently Kafka-only (30d retention, not queryable). connector_dlq_record
--   persists each dead-letter so they are: (a) queryable beyond the 30d Kafka window,
--   (b) correlated to brand for tenant-scoped forensics, and (c) redriveable by operators
--   using the dlq-redrive job.
--   Columns: dlq_id (uuid PK), brand_id (RLS anchor), source_topic, partition, kafka_offset,
--            provider, payload (jsonb), error_class, error_detail, first_seen_at, redrive_count,
--            created_at (partition key).
--   Idempotency: UNIQUE (source_topic, partition, kafka_offset) — an exactly-once producer
--   may re-deliver on transient broker errors; dedup on the Kafka address triple is safe.
--   Partitioned by RANGE(created_at) — children born-secure.
--
-- ROLLBACK: rename connector_webhook_raw_archive_legacy → connector_webhook_raw_archive
--   (DROP the _part twin); DROP connector_dlq_record and its children.
-- ============================================================================

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PART A: Partition connector_webhook_raw_archive (twin-swap)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── A-1. Build the partitioned twin ─────────────────────────────────────────
--
-- UNIQUE KEY NOTE: PostgreSQL requires every UNIQUE constraint on a partitioned table
-- to include the partition key column. The dedup key widens to include received_at.
-- This means identical payloads delivered in different calendar months are each stored
-- once per month — acceptable for a raw forensic archive (each delivery is a fact).
-- Writers use ON CONFLICT (brand_id, topic, body_sha256, received_at) DO NOTHING.
-- Within a single partition (month), the dedup is exact.
CREATE TABLE connectors.connector_webhook_raw_archive_part (
  id             BIGSERIAL    NOT NULL,
  brand_id       UUID         NOT NULL,
  source         TEXT         NOT NULL,
  topic          TEXT         NOT NULL,
  body_sha256    TEXT         NOT NULL,
  received_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  correlation_id TEXT         NULL,
  redacted_body  JSONB        NOT NULL,
  PRIMARY KEY (brand_id, id, received_at),
  -- Idempotent re-delivery within the same month partition.
  CONSTRAINT connector_webhook_raw_archive_dedup_p
    UNIQUE (brand_id, topic, body_sha256, received_at)
) PARTITION BY RANGE (received_at);

-- Seed partitions: current month + 2 ahead + a DEFAULT catch-all.
CREATE TABLE connectors.connector_webhook_raw_archive_p2026_06
  PARTITION OF connectors.connector_webhook_raw_archive_part
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE connectors.connector_webhook_raw_archive_p2026_07
  PARTITION OF connectors.connector_webhook_raw_archive_part
  FOR VALUES FROM ('2026-07-01+00') TO ('2026-08-01+00');
CREATE TABLE connectors.connector_webhook_raw_archive_p2026_08
  PARTITION OF connectors.connector_webhook_raw_archive_part
  FOR VALUES FROM ('2026-08-01+00') TO ('2026-09-01+00');
CREATE TABLE connectors.connector_webhook_raw_archive_pdefault
  PARTITION OF connectors.connector_webhook_raw_archive_part DEFAULT;

-- ── A-2. Copy existing data ──────────────────────────────────────────────────
INSERT INTO connectors.connector_webhook_raw_archive_part
  (id, brand_id, source, topic, body_sha256, received_at, correlation_id, redacted_body)
SELECT id, brand_id, source, topic, body_sha256, received_at, correlation_id, redacted_body
FROM connectors.connector_webhook_raw_archive;

-- Advance the sequence past the maximum existing id (avoids PK collision on new inserts).
SELECT setval(
  pg_get_serial_sequence('connectors.connector_webhook_raw_archive_part', 'id'),
  COALESCE((SELECT MAX(id) FROM connectors.connector_webhook_raw_archive), 0) + 1,
  false
);

-- ── A-3. Indexes + RLS + grants on the twin ──────────────────────────────────
-- Operator lookup by brand + recency (mirrors the legacy idx).
CREATE INDEX idx_cwra_brand_recent_p
  ON connectors.connector_webhook_raw_archive_part (brand_id, received_at DESC);

ALTER TABLE connectors.connector_webhook_raw_archive_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors.connector_webhook_raw_archive_part FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_webhook_raw_archive_isolation ON connectors.connector_webhook_raw_archive_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- Append-only by grant (no UPDATE/DELETE — immutable shape history).
REVOKE ALL ON connectors.connector_webhook_raw_archive_part FROM brain_app;
GRANT SELECT, INSERT ON connectors.connector_webhook_raw_archive_part TO brain_app;

-- ── A-4. Born-secure all existing partition children ────────────────────────
--   (0084 locks down pre-existing children; we mirror that pattern here to be
--    self-contained in case this migration runs before or independently of 0084.)
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c       ON c.oid = i.inhrelid
    JOIN pg_namespace n   ON n.oid = c.relnamespace
    WHERE i.inhparent = 'connectors.connector_webhook_raw_archive_part'::regclass
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM brain_app', r.schema, r.child);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema, r.child);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schema, r.child);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.child || '_isolation', r.schema, r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO brain_app '
      'USING (brand_id = current_setting(''app.current_brand_id'', TRUE)::uuid)',
      r.child || '_isolation', r.schema, r.child);
  END LOOP;
END $$;

-- ── A-5. Atomic swap ─────────────────────────────────────────────────────────
ALTER TABLE connectors.connector_webhook_raw_archive
  RENAME TO connector_webhook_raw_archive_legacy;
ALTER TABLE connectors.connector_webhook_raw_archive_part
  RENAME TO connector_webhook_raw_archive;

-- ── A-6. Post-swap guards ────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part
  FROM pg_class
  WHERE oid = 'connectors.connector_webhook_raw_archive'::regclass;
  IF NOT is_part THEN
    RAISE EXCEPTION '0094-A: connector_webhook_raw_archive must be PARTITIONED after swap';
  END IF;

  SELECT count(*) INTO legacy_n FROM connectors.connector_webhook_raw_archive_legacy;
  SELECT count(*) INTO new_n    FROM connectors.connector_webhook_raw_archive;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0094-A: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;

  -- Every child partition must have FORCE RLS enabled (born-secure invariant).
  DECLARE leak int;
  BEGIN
    SELECT count(*) INTO leak
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'connectors.connector_webhook_raw_archive'::regclass
      AND NOT c.relforcerowsecurity;
    IF leak <> 0 THEN
      RAISE EXCEPTION '0094-A: % connector_webhook_raw_archive child partition(s) missing FORCE RLS', leak;
    END IF;
  END;
END $$;

-- connector_webhook_raw_archive_legacy is retained for the post-deploy verify window.
-- DROP it in a follow-up migration once the partitioned table is confirmed in prod.


-- ═══════════════════════════════════════════════════════════════════════════════
-- PART B: connector_dlq_record — queryable, brand-scoped, partitioned DLQ store
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── B-1. Partitioned parent ──────────────────────────────────────────────────
--
-- UNIQUE KEY NOTE: PostgreSQL requires every UNIQUE constraint on a partitioned table
-- to include the partition key column (created_at). The application-layer idempotency
-- guarantee is implemented as follows:
--   • dlq_id is a DETERMINISTIC UUID v5 derived from (source_topic, partition, kafka_offset).
--     Same Kafka address always produces the same dlq_id (see DlqRecordRepository).
--   • created_at is set by the writer to date_trunc('day', now()) — day-granular.
--     Same Kafka address written on the same calendar day → identical PK → ON CONFLICT
--     DO NOTHING dedups correctly.
--   • Cross-day re-writes (operator runs redrive in a new day) produce a second row, which
--     is acceptable for a forensic store (both rows are accurate: message was seen twice).
--   • Kafka offsets never reuse within a topic+partition, so in normal operations the same
--     address is written at most once (the consumer group committed the offset after the
--     first write, so it won't re-read in the same session).
CREATE TABLE connectors.connector_dlq_record (
  dlq_id        UUID        NOT NULL,              -- deterministic UUID v5 from Kafka address (app-set)
  brand_id      UUID        NOT NULL,              -- RLS anchor / tenant key
  source_topic  TEXT        NOT NULL,              -- Kafka topic the message was DLQ'd from
  partition     INT         NOT NULL,              -- Kafka partition
  kafka_offset  BIGINT      NOT NULL,              -- Kafka offset (idempotency key with topic+partition)
  provider      TEXT        NOT NULL,              -- connector provider (e.g. 'shopify', 'gokwik')
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- original message body (sanitised, no PII keys)
  error_class   TEXT        NOT NULL,              -- exception class / error code (e.g. 'ECONNREFUSED')
  error_detail  TEXT        NOT NULL DEFAULT '',   -- short description (not a raw stack trace)
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  redrive_count INT         NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL,              -- partition key; writer sets to date_trunc('day', now())
  -- PK includes created_at (required for PG RANGE partitioned UNIQUE); dlq_id is deterministic
  -- from the Kafka address so same-day retries ON CONFLICT DO NOTHING against this PK.
  PRIMARY KEY (brand_id, dlq_id, created_at)
) PARTITION BY RANGE (created_at);

COMMENT ON TABLE connectors.connector_dlq_record IS
  'Queryable forensic store for Kafka dead-letters. dlq_id is a deterministic UUID v5 from '
  '(source_topic, partition, kafka_offset); created_at is day-truncated by the writer so same-day '
  'retries dedup via PK. Extends retention beyond the 30d Kafka DLQ window.';

COMMENT ON COLUMN connectors.connector_dlq_record.partition IS
  'Kafka partition — "partition" is not a reserved word in PG; the column name is intentional.';

COMMENT ON COLUMN connectors.connector_dlq_record.created_at IS
  'Set by the writer to date_trunc(''day'', now()) for day-level idempotency (same-day retries '
  'dedup via PK; cross-day re-writes produce a second row, acceptable for a forensic store).';

-- ── B-2. Seed time partitions + DEFAULT ─────────────────────────────────────
CREATE TABLE connectors.connector_dlq_record_p2026_06
  PARTITION OF connectors.connector_dlq_record
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE connectors.connector_dlq_record_p2026_07
  PARTITION OF connectors.connector_dlq_record
  FOR VALUES FROM ('2026-07-01+00') TO ('2026-08-01+00');
CREATE TABLE connectors.connector_dlq_record_p2026_08
  PARTITION OF connectors.connector_dlq_record
  FOR VALUES FROM ('2026-08-01+00') TO ('2026-09-01+00');
CREATE TABLE connectors.connector_dlq_record_pdefault
  PARTITION OF connectors.connector_dlq_record DEFAULT;

-- ── B-3. Indexes on parent ───────────────────────────────────────────────────
-- Operator forensic lookup: all DLQ records for a brand, newest first.
CREATE INDEX idx_cdlqr_brand_created
  ON connectors.connector_dlq_record (brand_id, created_at DESC);

-- Lookup by error class for bulk redrive targeting.
CREATE INDEX idx_cdlqr_brand_error_class
  ON connectors.connector_dlq_record (brand_id, error_class, created_at DESC);

-- Kafka address lookup: find an existing record for a given Kafka message (dedup check).
CREATE INDEX idx_cdlqr_kafka_addr
  ON connectors.connector_dlq_record (source_topic, partition, kafka_offset);

-- ── B-4. RLS + grants on parent ──────────────────────────────────────────────
ALTER TABLE connectors.connector_dlq_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors.connector_dlq_record FORCE ROW LEVEL SECURITY;

CREATE POLICY connector_dlq_record_isolation ON connectors.connector_dlq_record
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

-- Append-only: the DLQ store is forensic-only; dead-letters are never mutated,
-- only INSERT'd (on first write) or counted (redrive_count incremented via redrive job).
-- redrive_count is updated by the redrive job — so UPDATE is needed.
REVOKE ALL ON connectors.connector_dlq_record FROM brain_app;
GRANT SELECT, INSERT, UPDATE ON connectors.connector_dlq_record TO brain_app;

-- ── B-5. Born-secure all existing partition children ─────────────────────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname AS schema, c.relname AS child
    FROM pg_inherits i
    JOIN pg_class c       ON c.oid = i.inhrelid
    JOIN pg_namespace n   ON n.oid = c.relnamespace
    WHERE i.inhparent = 'connectors.connector_dlq_record'::regclass
  LOOP
    EXECUTE format('REVOKE ALL ON %I.%I FROM brain_app', r.schema, r.child);
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', r.schema, r.child);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', r.schema, r.child);
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I.%I',
      r.child || '_isolation', r.schema, r.child);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO brain_app '
      'USING (brand_id = current_setting(''app.current_brand_id'', TRUE)::uuid)',
      r.child || '_isolation', r.schema, r.child);
  END LOOP;
END $$;

-- ── B-6. Post-creation guards ────────────────────────────────────────────────
DO $$
DECLARE is_part boolean; leak int;
BEGIN
  SELECT relkind = 'p' INTO is_part
  FROM pg_class
  WHERE oid = 'connectors.connector_dlq_record'::regclass;
  IF NOT is_part THEN
    RAISE EXCEPTION '0094-B: connector_dlq_record must be PARTITIONED';
  END IF;

  -- All children born-secure.
  SELECT count(*) INTO leak
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = 'connectors.connector_dlq_record'::regclass
    AND NOT c.relforcerowsecurity;
  IF leak <> 0 THEN
    RAISE EXCEPTION '0094-B: % connector_dlq_record child partition(s) missing FORCE RLS', leak;
  END IF;

  -- NN-1: isolation policies must use the two-arg form of current_setting.
  DECLARE bad_policy RECORD;
  BEGIN
    FOR bad_policy IN
      SELECT schemaname, tablename, policyname, qual
      FROM pg_policies
      WHERE tablename IN ('connector_dlq_record', 'connector_webhook_raw_archive')
        AND schemaname = 'connectors'
        AND (
          qual LIKE '%current_setting(''app.current_brand_id'')%'
          AND qual NOT LIKE '%current_setting(''app.current_brand_id'', TRUE)%'
          AND qual NOT LIKE '%current_setting(''app.current_brand_id'', true)%'
        )
    LOOP
      RAISE EXCEPTION
        'NN-1 VIOLATION: Policy "%" on %.% uses one-arg current_setting. '
        'Replace with two-arg form.',
        bad_policy.policyname, bad_policy.schemaname, bad_policy.tablename;
    END LOOP;
  END;
END $$;

COMMIT;
