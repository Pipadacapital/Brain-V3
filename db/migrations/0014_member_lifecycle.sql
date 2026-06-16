-- ============================================================================
-- 0014_member_lifecycle.sql — Partial unique indexes for invite lifecycle
-- ============================================================================
-- D-10 (architecture-plan §2): prevent dual valid tokens for the same invite slot.
--
-- Two partial unique indexes mirror the compound-RLS split (NN-7):
--   • Org-level  — brand_id IS NULL  → uniqueness within the org
--   • Brand-level — brand_id IS NOT NULL → uniqueness within the brand
-- Same email across DIFFERENT brands in one org is legitimate (user can hold
-- brand-A membership and receive a new invite to brand-B).
--
-- Supporting index for the pending-list query (status + org, keyset by id).
--
-- ADDITIVE ONLY — no column drops, no data loss (I-E02 invariant).
-- ROLLBACK (migrate down): DROP INDEX IF EXISTS for all three; zero data impact.
--
-- Pre-flight guard: RAISE EXCEPTION if duplicate pending rows already exist so the
-- index build fails loud with a remediation message, not silently on the constraint.
-- ============================================================================

-- ── Pre-flight duplicate check ────────────────────────────────────────────────
-- Org-level duplicates (brand_id IS NULL, same organization + email + pending)
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT organization_id, email, count(*) AS n
    FROM invite
    WHERE status = 'pending' AND brand_id IS NULL
    GROUP BY organization_id, email
    HAVING count(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      '0014 pre-flight: % duplicate pending org-level invite(s) detected. '
      'Remediate by revoking extras (UPDATE invite SET status=''revoked'' WHERE ...) '
      'then re-run migration.', dup_count;
  END IF;
END $$;

-- Brand-level duplicates (brand_id IS NOT NULL, same brand + email + pending)
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT count(*) INTO dup_count
  FROM (
    SELECT brand_id, email, count(*) AS n
    FROM invite
    WHERE status = 'pending' AND brand_id IS NOT NULL
    GROUP BY brand_id, email
    HAVING count(*) > 1
  ) t;
  IF dup_count > 0 THEN
    RAISE EXCEPTION
      '0014 pre-flight: % duplicate pending brand-level invite(s) detected. '
      'Remediate by revoking extras (UPDATE invite SET status=''revoked'' WHERE ...) '
      'then re-run migration.', dup_count;
  END IF;
END $$;

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- D-10 / org-level: only one pending invite per (org, email) at the org scope.
-- CONCURRENTLY cannot run inside a transaction; node-pg-migrate wraps each file
-- in a txn by default — use plain CREATE UNIQUE INDEX (blocked by pre-flight above).
CREATE UNIQUE INDEX IF NOT EXISTS invite_pending_org_email_uniq
  ON invite (organization_id, email)
  WHERE status = 'pending' AND brand_id IS NULL;

-- D-10 / brand-level: only one pending invite per (brand, email) at the brand scope.
CREATE UNIQUE INDEX IF NOT EXISTS invite_pending_brand_email_uniq
  ON invite (brand_id, email)
  WHERE status = 'pending' AND brand_id IS NOT NULL;

-- Supporting index for the pending-list query (listPending): status + org, keyset by id.
CREATE INDEX IF NOT EXISTS invite_status_org_idx
  ON invite (organization_id, status) WHERE status = 'pending';
