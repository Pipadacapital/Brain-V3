-- 0101_drop_pg_identity_tables.sql
--
-- MEDALLION REALIGNMENT (Epic 3 / ADR-0004): IDENTITY OUT OF POSTGRESQL — Neo4j is the system-of-record.
--
-- The identity GRAPH now lives in Neo4j (customer nodes, identifier→brain_id IDENTIFIES edges, merge
-- events, ALIAS_OF, SharedUtility phone-guard, MergeReview). The resolver (Neo4jIdentityRepository) writes
-- it; every reader is migrated: Customer 360 / browse / merge-admin / GDPR erase / vault coverage / CAPI
-- subject-hash (Neo4jIdentityReader), the gold revenue ledger + customer marts (silver_identity_link, the
-- Neo4j→StarRocks export), journey-stitch + phone-guard-reeval (Neo4j / silver_identity_link), and the
-- Shopify GDPR redact webhook (Neo4j reader). Existing identity was backfilled into Neo4j; brain_id parity
-- verified (gold ledger: identical 747 distinct brain_ids).
--
-- PER ADR-0004, identity_audit (immutable compliance ledger) + contact_pii (encrypted raw-PII vault) STAY
-- in PostgreSQL — they are NOT dropped. The contact_pii hard-delete is via erase_contact_pii_for_customer
-- (0100). This migration drops the graph tables + their SECURITY DEFINER helper functions.
--
-- DESTRUCTIVE + IRREVERSIBLE for the PG copy. Safe: Neo4j is the proven SoR (resolver mint/link/merge +
-- all reader live tests green; gold-ledger brain_id parity). ROLLBACK: restore from 0017/0019/0038/0039
-- (+ the connector shopify-resolver migration) and re-point the resolver/readers to PG.

-- ── 1. Drop the SECURITY DEFINER helper functions over the identity tables ──
DROP FUNCTION IF EXISTS erase_customer(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS resolve_merge_review(uuid, uuid, text) CASCADE;
DROP FUNCTION IF EXISTS admin_unmerge_customer(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS customer_list_for_brand(uuid, text, text[], integer, integer) CASCADE;
DROP FUNCTION IF EXISTS resolve_brain_id_by_shopify_customer(uuid, text) CASCADE;

-- ── 2. Drop the identity graph tables (CASCADE drops the inter-table FKs among them). ──
-- KEEP: identity.identity_audit + identity.contact_pii (ADR-0004). Order child→parent for clarity;
-- CASCADE makes order irrelevant.
DROP TABLE IF EXISTS identity.brain_id_alias CASCADE;
DROP TABLE IF EXISTS identity.identity_merge_event CASCADE;
DROP TABLE IF EXISTS identity.merge_review_queue CASCADE;
DROP TABLE IF EXISTS identity.shared_utility_identifier CASCADE;
DROP TABLE IF EXISTS identity.identity_link CASCADE;
DROP TABLE IF EXISTS identity.customer CASCADE;

-- ── 3. Migration-time assertion: the 6 graph tables are gone; audit + contact_pii survive. ──
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'identity'
       AND c.relname IN ('customer','identity_link','identity_merge_event','brain_id_alias','shared_utility_identifier','merge_review_queue')
  ) THEN
    RAISE EXCEPTION 'DROP GUARD (0101): a PG identity graph table still exists.';
  END IF;
  -- identity_audit lives in the `audit` schema (partitioned, migration 0075) — it must SURVIVE.
  IF to_regclass('audit.identity_audit') IS NULL THEN
    RAISE EXCEPTION 'DROP GUARD (0101): audit.identity_audit must SURVIVE (ADR-0004) — it does not.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='identity' AND c.relname='contact_pii') THEN
    RAISE EXCEPTION 'DROP GUARD (0101): contact_pii must SURVIVE (ADR-0004) — it does not.';
  END IF;
END
$$;
