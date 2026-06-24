/**
 * Dashboard cross-context query helpers (CQ-1 decomposition).
 *
 * The dashboard BFF handlers previously embedded raw cross-context SELECTs against
 * app_user / membership / organization / brand / connector_instance / connector_sync_status
 * / pixel_installation / pixel_status inline. They are consolidated here as clearly-named,
 * RLS-aware query helpers so the handlers read as intent, not SQL. Each helper takes an
 * already-connected @brain/db client + a QueryContext and returns EXACTLY the same rows the
 * handler consumed — behavior is unchanged (this is a move, not a rewrite).
 */

import type { QueryContext } from '@brain/db';

// @brain/db pool clients are RLS-aware (ctx carries the GUCs). We keep the helper signature
// minimal (the bits the queries use) so we don't depend on the concrete client type here.
export interface DbClient {
  query<R>(ctx: QueryContext, text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

// ── brand-summary ──────────────────────────────────────────────────────────────

export interface OrgRow { id: string; name: string }
export interface BrandRow { id: string; display_name: string; domain: string | null; status: string }

/** The org row for the active workspace. */
export function queryOrganization(client: DbClient, ctx: QueryContext, workspaceId: string) {
  return client.query<OrgRow>(ctx, `SELECT id, name FROM organization WHERE id = $1`, [workspaceId]);
}

/**
 * All member brands within the active workspace (drives the switcher, newest first).
 * brand_self_read (0013) ensures brain_app sees only member brands in the active org.
 */
export function queryBrandList(client: DbClient, ctx: QueryContext, workspaceId: string) {
  return client.query<BrandRow>(
    ctx,
    `SELECT id, display_name, domain, status FROM brand WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [workspaceId],
  );
}

/**
 * Per-active-brand member count (MA-06/SD-2). COUNT DISTINCT eliminates the owner's
 * dual (org-level + brand-level) membership rows. Caller guards a null brandId to 0.
 */
export function queryActiveBrandMemberCount(
  client: DbClient,
  ctx: QueryContext,
  workspaceId: string,
  brandId: string,
) {
  return client.query<{ count: string }>(
    ctx,
    `SELECT COUNT(DISTINCT app_user_id)::text AS count FROM membership WHERE organization_id = $1 AND brand_id = $2`,
    [workspaceId, brandId],
  );
}

// ── connection-status ────────────────────────────────────────────────────────────

export interface ConnRow {
  status: string;
  shop_domain: string;
  connector_instance_id: string;
  sync_state: string | null;
  last_sync_at: Date | null;
  last_error: string | null;
}

/**
 * Latest connector_instance for (brand, provider) LEFT JOINed to its sync status.
 * RLS scopes brand_id via the QueryContext.
 */
export function queryLatestConnectorWithSync(
  client: DbClient,
  ctx: QueryContext,
  brandId: string,
  provider: string,
) {
  return client.query<ConnRow>(
    ctx,
    `SELECT ci.status, ci.shop_domain, ci.id AS connector_instance_id,
                  cs.state AS sync_state, cs.last_sync_at, cs.last_error
           FROM connector_instance ci
           LEFT JOIN connector_sync_status cs ON cs.connector_instance_id = ci.id AND cs.brand_id = ci.brand_id
           WHERE ci.brand_id = $1 AND ci.provider = $2
           ORDER BY ci.created_at DESC
           LIMIT 1`,
    [brandId, provider],
  );
}

// ── data-status (pixel) ───────────────────────────────────────────────────────────

export interface PixelStatusRow {
  installation_id: string;
  install_token: string;
  target_host: string;
  installed_at: Date | null;
  state: string | null;
  verified_at: Date | null;
  last_error: string | null;
}

/** Latest pixel_installation for the brand LEFT JOINed to its pixel_status. */
export function queryLatestPixelStatus(client: DbClient, ctx: QueryContext, brandId: string) {
  return client.query<PixelStatusRow>(
    ctx,
    `SELECT pi.id AS installation_id, pi.install_token, pi.target_host, pi.installed_at,
                  ps.state, ps.verified_at, ps.last_error
           FROM pixel_installation pi
           LEFT JOIN pixel_status ps ON ps.pixel_installation_id = pi.id AND ps.brand_id = pi.brand_id
           WHERE pi.brand_id = $1
           ORDER BY pi.created_at DESC
           LIMIT 1`,
    [brandId],
  );
}

// ── onboarding-progress ───────────────────────────────────────────────────────────

/** Step 1: the user's email_verified_at (NULL ⇒ unverified). */
export function queryUserEmailVerified(client: DbClient, ctx: QueryContext, userId: string) {
  return client.query<{ email_verified_at: Date | null }>(
    ctx,
    `SELECT email_verified_at FROM app_user WHERE id = $1`,
    [userId],
  );
}

/** Step 2: count of org-level membership rows (workspace created) for this user. */
export function queryWorkspaceMembershipCount(
  client: DbClient,
  ctx: QueryContext,
  workspaceId: string,
  userId: string,
) {
  return client.query<{ count: string }>(
    ctx,
    `SELECT COUNT(*)::text AS count FROM membership WHERE organization_id = $1 AND brand_id IS NULL AND app_user_id = $2`,
    [workspaceId, userId],
  );
}

/** Step 3: count of brands in the workspace (first brand created). */
export function queryBrandCount(client: DbClient, ctx: QueryContext, workspaceId: string) {
  return client.query<{ count: string }>(
    ctx,
    `SELECT COUNT(*)::text AS count FROM brand WHERE organization_id = $1`,
    [workspaceId],
  );
}

/** Step 4: count of connected Shopify connector instances for the brand. */
export function queryShopifyConnectedCount(client: DbClient, ctx: QueryContext, brandId: string) {
  return client.query<{ count: string }>(
    ctx,
    `SELECT COUNT(*)::text AS count FROM connector_instance WHERE brand_id = $1 AND provider = 'shopify' AND status = 'connected'`,
    [brandId],
  );
}

/** Step 5: count of installed pixels for the brand (installed_at NOT NULL). */
export function queryPixelInstalledCount(client: DbClient, ctx: QueryContext, brandId: string) {
  return client.query<{ count: string }>(
    ctx,
    `SELECT COUNT(*)::text AS count FROM pixel_installation WHERE brand_id = $1 AND installed_at IS NOT NULL`,
    [brandId],
  );
}
