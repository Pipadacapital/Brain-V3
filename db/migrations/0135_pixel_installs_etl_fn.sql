--
-- 0135_pixel_installs_etl_fn.sql — RLS-bypassing ETL read for the Silver keystone's R2 tenant gate.
--
-- BUG (live prod, 2026-07-16): the v4-silver keystone (silver_collector_event.py) resolves pixel-lane
-- events to brands via install_token by reading pixel.pixel_installation over the DuckDB postgres
-- extension, connected with credentials derived from core-env (the brain_app role). pixel_installation
-- is ENABLE+FORCE RLS with a brain_app-targeted brand-GUC policy, and the ETL session sets no GUC → the
-- read returns ZERO rows ({"job":"silver-collector-event","pg":"ok","install_tokens":0}) → the R2 INNER
-- join resolves nothing → EVERY pixel event drops as tenant_unresolved. Bronze filled with page.viewed /
-- session.* / element.clicked while silver_page_view / silver_touchpoint stayed at 0. Dev never hit this:
-- the docker 'brain' user is a superuser (always bypasses RLS).
--
-- FIX: the codebase's cross-brand system-read pattern (0019 list_active_brand_ids): a SECURITY DEFINER
-- function owned by the migration role (the Aurora master carries rds_superuser → BYPASSRLS), returning
-- ONLY the two columns the tenant gate needs — install_token → brand_id, no PII, no host/refs. EXECUTE
-- granted to brain_app so the ETL session (and any future operational reader) can call it. text return
-- types keep the DuckDB postgres_query() mapping trivial.
--
BEGIN;

CREATE OR REPLACE FUNCTION pixel.pixel_installations_for_etl()
RETURNS TABLE(install_token text, brand_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'pixel'
AS $$
  SELECT install_token::text, brand_id::text
  FROM pixel.pixel_installation
  WHERE install_token IS NOT NULL
$$;

REVOKE ALL ON FUNCTION pixel.pixel_installations_for_etl() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pixel.pixel_installations_for_etl() TO brain_app;

COMMIT;
