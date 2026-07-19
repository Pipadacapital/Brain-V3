--
-- 0143_product_cost_sheet_authority.sql — DR-003 (docs/data-platform/design-review-003).
--
-- Per-SKU unit COGS authority = the brand-uploaded cost sheet. The table moves out of `public`
-- and loses its mart-shaped name (public.gold_product_costs → billing.product_cost_sheet):
-- that name is what let the C.2.4 upload path stay silently disconnected from the economics
-- chain (the Iceberg gold_product_costs mart read billing.cost_input instead — fixed in the
-- same PR by repointing db/iceberg/duckdb/gold/gold_product_costs.py to this table).
--
-- ZERO-DOWNTIME: a one-release compatibility VIEW keeps the old name resolving for not-yet-
-- replaced app pods. security_invoker (PG15+; prod is PG16) → RLS evaluates as the querying
-- role (brain_app), identical to a direct table read. product-costs.ts deliberately avoids
-- ON CONFLICT (its own comment), so the plain auto-updatable view covers its INSERT/UPDATE/
-- SELECT exactly. A follow-up migration (0144, next wave) drops the view once traffic is zero.
--
-- SET SCHEMA / RENAME are metadata-only (instant); constraints (incl. the (sku,currency,
-- daterange) no-overlap exclusion), indexes, grants, and the RLS policy travel with the table.
--
-- PROD PRE-GATE (runbook): SELECT count(*) FROM billing.cost_input
--   WHERE scope='sku' AND cost_type='cogs';  -- expected 0 (mart docstring-verified);
-- if >0, copy those rows into billing.product_cost_sheet BEFORE the mart repoint deploys.
--
-- VALIDATION:
--   SELECT to_regclass('billing.product_cost_sheet') IS NOT NULL;                      -- t
--   SELECT relkind FROM pg_class WHERE oid='public.gold_product_costs'::regclass;      -- v
--   SELECT count(*) FROM pg_constraint
--     WHERE conrelid='billing.product_cost_sheet'::regclass AND contype='x';           -- 1
--   SELECT count(*) FROM pg_policies
--     WHERE schemaname='billing' AND tablename='product_cost_sheet';                   -- >=1
--
-- ROLLBACK:
--   DROP VIEW IF EXISTS public.gold_product_costs;
--   ALTER TABLE billing.product_cost_sheet RENAME TO gold_product_costs;
--   ALTER TABLE billing.gold_product_costs SET SCHEMA public;
--

ALTER TABLE public.gold_product_costs SET SCHEMA billing;
ALTER TABLE billing.gold_product_costs RENAME TO product_cost_sheet;

CREATE VIEW public.gold_product_costs WITH (security_invoker = true)
  AS SELECT * FROM billing.product_cost_sheet;
GRANT SELECT, INSERT, UPDATE ON public.gold_product_costs TO brain_app;
