-- ============================================================================
-- 0058_pixel_auto_install.sql — auto-install + per-tenant ingest-host columns
-- ============================================================================
-- feat-pixel-production-install: the production install path auto-injects the pixel
-- onto the storefront via the Shopify Admin API (ScriptTag now; Web Pixels laid) and
-- flips installed_at — no manual snippet paste. These columns record WHAT was injected
-- (so install is idempotent + uninstallable) and the optional first-party CNAME host.
--
-- ADDITIVE + REVERSIBLE: ADD COLUMN IF NOT EXISTS only; no backfill, no constraint
-- changes. Existing rows get NULLs (= "manually installed / not auto-installed"), which
-- is the correct, honest default. RLS + grants on pixel_installation are unchanged (0007).
-- ============================================================================

-- Which mechanism auto-installed the pixel (NULL = manual snippet paste, the legacy path).
ALTER TABLE pixel_installation
  ADD COLUMN IF NOT EXISTS auto_install_provider TEXT
    CHECK (auto_install_provider IN ('shopify_script_tag', 'shopify_web_pixel'));

-- The provider-side handle for the injected pixel (Shopify ScriptTag id or Web Pixel id),
-- so re-running install is idempotent and uninstall can delete the exact resource.
ALTER TABLE pixel_installation
  ADD COLUMN IF NOT EXISTS auto_install_ref TEXT;

-- Optional per-tenant first-party ingest host (the CNAME, e.g. pixel.merchant.com → collector).
-- When set, the snippet/asset + the injected src use this host so cookies are first-party
-- (ITP defense). NULL = use the global PIXEL_INGEST_BASE_URL.
ALTER TABLE pixel_installation
  ADD COLUMN IF NOT EXISTS custom_ingest_host TEXT;
