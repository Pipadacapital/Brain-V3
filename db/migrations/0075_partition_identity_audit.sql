-- 0075_partition_identity_audit.sql
--
-- DB-AUDIT C4b — partition the biggest unbounded append-only log. audit.identity_audit records every
-- identity action (mint/link/merge/unmerge/rebind/erase) per brain forever with no retention (157k+
-- rows already in dev, the largest of the unbounded logs). This applies the PROVEN, prod-safe twin-swap
-- template (see 0072_partition_dq_check_result.sql): build a RANGE-partitioned twin (by occurred_at),
-- copy data, recreate indexes + RLS + grants, then atomically swap.
-- Retention becomes a partition DROP (O(1)) instead of a giant DELETE; queries prune by time.
--
-- PostgreSQL requires the partition key in every UNIQUE/PK → PK becomes (brand_id, audit_id,
-- occurred_at). Harmless: audit_id is already unique (gen_random_uuid default); this only widens the
-- key. Both writers (stream-worker IdentityRepository + erase-customer) INSERT fresh rows with NO
-- ON CONFLICT and DO NOT supply occurred_at (it defaults to now()), so the wider PK changes nothing
-- for writers. occurred_at is NOT NULL DEFAULT now() → partition routing is always satisfied.
--
-- PROD partition management: a monthly create-ahead + drop-old routine (pg_partman or a cron) maintains
-- partitions; here we seed a DEFAULT + the observed month so dev + a fresh prod both work.
-- DEPLOY: this migration is self-contained (copy+swap in one txn); safe to run online for a log table.

-- ── 1. Partitioned twin ──────────────────────────────────────────────────────────────────────────
CREATE TABLE audit.identity_audit_part (
  brand_id    uuid                     NOT NULL,
  audit_id    uuid                     NOT NULL DEFAULT gen_random_uuid(),
  brain_id    uuid                     NOT NULL,
  action      text                     NOT NULL,
  merge_id    uuid,
  detail      jsonb                    NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz              NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_id, audit_id, occurred_at),
  CONSTRAINT identity_audit_action_check CHECK (action = ANY (ARRAY['mint','link','merge','unmerge','rebind','erase']))
) PARTITION BY RANGE (occurred_at);

-- Time partitions (seed: the observed data month) + a DEFAULT so no row is ever rejected.
CREATE TABLE audit.identity_audit_p2026_06 PARTITION OF audit.identity_audit_part
  FOR VALUES FROM ('2026-06-01+00') TO ('2026-07-01+00');
CREATE TABLE audit.identity_audit_pdefault PARTITION OF audit.identity_audit_part DEFAULT;

-- ── 2. Copy existing data ────────────────────────────────────────────────────────────────────────
INSERT INTO audit.identity_audit_part
  (brand_id, audit_id, brain_id, action, merge_id, detail, occurred_at)
SELECT brand_id, audit_id, brain_id, action, merge_id, detail, occurred_at
FROM audit.identity_audit;

-- ── 3. Recreate the brain-lookup index + RLS + grants on the twin ──────────────────────────────────
-- _p suffix avoids a name collision with the legacy table during the verify window.
CREATE INDEX idx_identity_audit_brain_p ON audit.identity_audit_part (brand_id, brain_id, occurred_at DESC);

ALTER TABLE audit.identity_audit_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.identity_audit_part FORCE ROW LEVEL SECURITY;
CREATE POLICY identity_audit_isolation ON audit.identity_audit_part
  AS PERMISSIVE FOR ALL TO brain_app
  USING (brand_id = current_setting('app.current_brand_id', TRUE)::uuid);

REVOKE ALL ON audit.identity_audit_part FROM brain_app;
GRANT SELECT, INSERT ON audit.identity_audit_part TO brain_app;  -- append-only audit log

-- ── 4. Atomic swap ─────────────────────────────────────────────────────────────────────────────────
ALTER TABLE audit.identity_audit      RENAME TO identity_audit_legacy;
ALTER TABLE audit.identity_audit_part RENAME TO identity_audit;

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE legacy_n bigint; new_n bigint; is_part boolean;
BEGIN
  SELECT relkind = 'p' INTO is_part FROM pg_class WHERE oid = 'audit.identity_audit'::regclass;
  IF NOT is_part THEN RAISE EXCEPTION '0075: identity_audit must be PARTITIONED after swap'; END IF;
  SELECT count(*) INTO legacy_n FROM audit.identity_audit_legacy;
  SELECT count(*) INTO new_n    FROM audit.identity_audit;
  IF new_n <> legacy_n THEN
    RAISE EXCEPTION '0075: row count mismatch after copy (legacy=%, new=%)', legacy_n, new_n;
  END IF;
END $$;

-- audit.identity_audit_legacy is retained for a post-deploy verification window; DROP it in a
-- follow-up migration once the partitioned table is confirmed serving reads + writes.
