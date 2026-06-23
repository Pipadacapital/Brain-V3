-- 0095_identity_link_pre_hashed_identifier_types.sql
--
-- BUGFIX (identity resolution — THE UNLOCK for the customer marts).
--
-- ResolveIdentityUseCase emits identifier_type 'pre_hashed_email' / 'pre_hashed_phone' for connector
-- order/checkout events that arrive with PII the upstream platform ALREADY hashed (Shopify /
-- WooCommerce / Shopflo / GoKwik). See apps/stream-worker/src/application/ResolveIdentityUseCase.ts
-- (the "connector-pre-hashed-identity" block) — these are a deliberate, distinct namespace from the
-- salted first-party 'email'/'phone' hashes.
--
-- BUT migration 0090's identifier_type CHECK never listed them. So every connector order event hit
-- `identity_link_identifier_type_check` (SQLSTATE 23514) inside IdentityRepository.writeOutcome,
-- the ENTIRE resolve transaction rolled back (customer + all links, even the valid email/storefront
-- links on the same event), identity.identity_link stayed EMPTY, billing.realized_revenue_ledger.brain_id
-- stayed NULL, and the whole customer lineage starved:
--   silver_customers → feature_customer_daily → gold_customer_scores → churn / VIP / LTV / cohorts.
-- (Symptom in the stream-worker log: repeated "violates check constraint identity_link_identifier_type_check".)
--
-- FIX: extend the CHECK to allow the two pre-hashed namespaces. ADDITIVE + REVERSIBLE — it only widens
-- the accepted set; no row changes, no data migration. Rollback = re-add the 0090 constraint without
-- the two values (only safe once no pre_hashed_* rows exist).
--
-- After this migration, NEW connector orders resolve correctly (LiveLedgerBridge/BrainIdResolver stamp
-- brain_id forward); the historical 1,185-order backlog is re-resolved by replaying the identity bridge
-- + the 0089 brain_id backfill (see the feature branch runbook).

BEGIN;

ALTER TABLE identity.identity_link
  DROP CONSTRAINT IF EXISTS identity_link_identifier_type_check;

ALTER TABLE identity.identity_link
  ADD CONSTRAINT identity_link_identifier_type_check
  CHECK (identifier_type = ANY (ARRAY[
    'email','phone','storefront_customer_id','auth_user_id','fp_cookie',
    'device_id','anon_id','ip','ua','name','pincode','location',
    'pre_hashed_email','pre_hashed_phone'
  ]));

-- Guard: assert the two pre-hashed namespaces are now accepted (fail loud if the ARRAY drifts).
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint WHERE conname = 'identity_link_identifier_type_check';
  IF def IS NULL OR def NOT LIKE '%pre_hashed_email%' OR def NOT LIKE '%pre_hashed_phone%' THEN
    RAISE EXCEPTION '0095 GUARD: identity_link CHECK must allow pre_hashed_email + pre_hashed_phone. Got: %', def;
  END IF;
END $$;

COMMIT;
