-- 0079_identity_first_identified_at.sql
--
-- DB-AUDIT H6 — identity history: distinguish first SEEN from first IDENTIFIED.
-- identity.customer.created_at = when the brain_id node was minted (often anonymous — a device/anon_id).
-- first_identified_at = the EARLIEST time a strong/durable identifier (storefront_customer_id, email,
-- phone, external_id) attached to this brain_id → the true acquisition / "became a known person" time.
-- NULL = still anonymous (seen but never identified). This is the acquisition anchor cohorts + LTV need
-- (created_at over-counts anonymous churned devices as "customers").

ALTER TABLE identity.customer ADD COLUMN IF NOT EXISTS first_identified_at timestamptz;

COMMENT ON COLUMN identity.customer.first_identified_at IS
  'H6: earliest time this brain_id attached a strong/durable identifier (acquisition / known time). '
  'NULL = anonymous-only. created_at = node mint time (first seen).';

-- Backfill from the earliest strong identity_link, resolving merged identities to their canonical
-- brain_id via brain_id_alias so a canonical customer inherits the earliest identification across merges.
UPDATE identity.customer c
SET first_identified_at = sub.fia
FROM (
  SELECT l.brand_id,
         COALESCE(a.canonical_brain_id, l.brain_id) AS brain_id,
         MIN(l.created_at)                          AS fia
  FROM identity.identity_link l
  LEFT JOIN identity.brain_id_alias a
    ON a.brand_id = l.brand_id AND a.observed_brain_id = l.brain_id AND a.valid_to IS NULL
  WHERE l.tier IN ('strong','strong_on_link') AND l.is_active = TRUE
  GROUP BY l.brand_id, COALESCE(a.canonical_brain_id, l.brain_id)
) sub
WHERE c.brand_id = sub.brand_id AND c.brain_id = sub.brain_id
  AND c.first_identified_at IS NULL;

-- Index for acquisition-cohort scans (brand_id, first_identified_at) over identified customers only.
CREATE INDEX IF NOT EXISTS idx_customer_first_identified
  ON identity.customer (brand_id, first_identified_at)
  WHERE first_identified_at IS NOT NULL;
