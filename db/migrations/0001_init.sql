-- 0001_init — RLS bootstrap (doc 04 §F.1 / doc 05 §9).
-- The app connects as a NON-OWNER role; BYPASSRLS is never granted.
-- Tenant context is set per-request and asserted non-null before any query.

-- Non-owner application role (no BYPASSRLS).
-- CREATE ROLE brain_app NOLOGIN;
-- GRANT brain_app TO <app_login>;

-- RLS policy template applied to every brand-scoped table:
--   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON <t>
--     USING (brand_id = current_setting('app.current_brand_id')::uuid);

-- audit_log is append-only: the app role gets INSERT + SELECT only (NO UPDATE/DELETE) — doc 04 §F.1.2.
-- TODO: organization, brand, app_user, role, permission, membership, session, invite,
--       brain_id_alias, contact_pii (send-service-only), gmv_meter_snapshot, brand_keyring, audit_log ...
