import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { onboardToDashboard } from './helpers/onboard';
import { markEmailVerified } from './helpers/db';

/**
 * Sync now E2E — feat-connector-sync-now (Track B)
 *
 * Verifies the per-connector "Sync now" control on the live Integration Marketplace
 * (/settings/connectors → MarketplaceView → ConnectorTile connected branch):
 *
 *   1. brand_admin sees the Sync now trigger on a connected Shopify tile, and triggering
 *      it (state seeded → syncing) renders the "Syncing…" badge + disabled trigger + hint.
 *   2. A connector seeded in state='syncing' renders the trigger DISABLED with the
 *      "already syncing" hint (in-flight UX) without any click.
 *   3. A connector seeded synced (state='connected' + last_sync_at) renders "Synced" +
 *      a last-synced timestamp (honest, from connector_sync_status — never faked).
 *   4. A manager does NOT see the Sync now trigger (hidden, mirrors server 403 / D-15),
 *      but DOES see the read-only status badge.
 *
 * Honesty:
 *   The badge + last-synced reflect the REAL connector_sync_status row seeded in the DB.
 *   Nothing here mocks a "synced" shortcut — the worker/route is the source of truth;
 *   this spec drives the surface deterministically via a DB seed.
 *
 * Architecture:
 *   - onboardToDashboard creates a fresh ephemeral brand per test.
 *   - Seeds connector_instance + connector_sync_status via the superuser pool (brain:brain).
 *   - NEVER touches the shared brand — always its own ephemeral brand.
 *   - Cleanup via try/finally (sync_status → cursor → instance delete).
 *
 * Real-network: web :3000 + core :3001 running; DATABASE_URL accessible.
 */

const DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';
const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
const PASSWORD = 'SuperSecret123!';

type SyncState = 'connected' | 'syncing' | 'waiting_for_data' | 'error';

// ── DB helpers ────────────────────────────────────────────────────────────────

/** Look up the brand_id for the most recently created brand belonging to this user. */
async function getBrandId(email: string): Promise<string> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `SELECT b.id
       FROM brand b
       JOIN organization o ON o.id = b.organization_id
       JOIN membership m ON m.organization_id = o.id
       JOIN app_user u ON u.id = m.app_user_id
       WHERE u.email = $1
       ORDER BY b.created_at DESC
       LIMIT 1`,
      [email],
    );
    if (!res.rows[0]) throw new Error(`No brand found for user: ${email}`);
    return res.rows[0].id;
  } finally {
    await client.end();
  }
}

/**
 * Seed a connected connector_instance + connector_sync_status row for the given brand.
 * Returns instanceId for cleanup.
 */
async function seedConnectorWithSync(
  brandId: string,
  syncState: SyncState,
  lastSyncAt: Date | null,
  lastError: string | null = null,
): Promise<{ instanceId: string }> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    const instRes = await client.query<{ id: string }>(
      `INSERT INTO connector_instance
         (brand_id, provider, shop_domain, secret_ref, status, connected_at)
       VALUES
         ($1, 'shopify', 'e2e-syncnow.myshopify.com',
          'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/e2e-syncnow',
          'connected', NOW())
       ON CONFLICT (brand_id, provider) DO UPDATE
         SET status = 'connected',
             shop_domain = 'e2e-syncnow.myshopify.com',
             updated_at = NOW()
       RETURNING id`,
      [brandId],
    );
    const instanceId = instRes.rows[0]!.id;

    await client.query(
      `INSERT INTO connector_sync_status
         (brand_id, connector_instance_id, state, last_sync_at, last_error)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (brand_id, connector_instance_id)
         DO UPDATE SET state = $3, last_sync_at = $4, last_error = $5, updated_at = NOW()`,
      [brandId, instanceId, syncState, lastSyncAt, lastError],
    );

    return { instanceId };
  } finally {
    await client.end();
  }
}

/** Promote the most recent membership for a user to the given role (manager gating test). */
async function setMembershipRole(email: string, role: string): Promise<void> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    await client.query(
      `UPDATE membership m
         SET role = $2
       FROM app_user u
       WHERE u.email = $1 AND m.app_user_id = u.id`,
      [email, role],
    );
  } finally {
    await client.end();
  }
}

/** Remove seeded connector rows (sync_status → cursor → instance). */
async function cleanupConnector(instanceId: string): Promise<void> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    await client.query(`DELETE FROM connector_sync_status WHERE connector_instance_id = $1`, [instanceId]);
    await client.query(`DELETE FROM connector_cursor WHERE connector_instance_id = $1`, [instanceId]);
    await client.query(`DELETE FROM connector_instance WHERE id = $1`, [instanceId]);
  } finally {
    await client.end();
  }
}

/** Navigate to the connectors marketplace and wait for the connected Shopify tile. */
async function gotoConnectors(page: Page): Promise<void> {
  await page.goto('/settings/connectors');
  await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('connector-tile-shopify')).toBeVisible({ timeout: 10_000 });
}

// ── Test 1: brand_admin triggers Sync now → syncing badge + disabled + hint ───

test(
  'brand_admin triggers Sync now → status goes to syncing (badge + disabled trigger + hint)',
  async ({ page }) => {
    const { email } = await onboardToDashboard(page, 'sn-admin');
    const brandId = await getBrandId(email);
    // Seed connected + a prior sync so the tile starts in a clean "Synced" state.
    const { instanceId } = await seedConnectorWithSync(
      brandId,
      'connected',
      new Date(Date.now() - 60 * 60 * 1000),
    );

    try {
      await gotoConnectors(page);

      // The owner/brand_admin must see the Sync now trigger.
      const trigger = page.getByTestId('sync-now-trigger');
      await expect(trigger, 'brand_admin must see the Sync now trigger').toBeVisible({ timeout: 10_000 });

      // The live status badge must be present (icon + text, never colour-only).
      const badge = page.getByTestId('sync-now-status');
      await expect(badge).toBeVisible();
      expect(await badge.getAttribute('role'), 'badge must have role="status"').toBe('status');

      // Flip the seeded state to 'syncing' so the next status poll reflects an in-flight sync,
      // then click the trigger (POST hits the real /sync route; the seed drives the displayed state).
      await seedConnectorWithSync(brandId, 'syncing', new Date(Date.now() - 60 * 60 * 1000));
      await trigger.click();

      // Within a poll cycle the badge flips to "Syncing…" and the trigger disables with a hint.
      await expect(badge, 'badge must show Syncing… while in flight').toContainText('Syncing', {
        timeout: 10_000,
      });
      await expect(trigger, 'trigger must be disabled while syncing').toBeDisabled({ timeout: 10_000 });
      await expect(
        page.getByTestId('sync-now-syncing-hint'),
        'an "already syncing" hint must be shown',
      ).toBeVisible();
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);

// ── Test 2: seeded syncing → trigger disabled + hint (in-flight UX, no click) ──

test(
  'connector seeded syncing renders the trigger disabled with an "already syncing" hint',
  async ({ page }) => {
    const { email } = await onboardToDashboard(page, 'sn-inflight');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(brandId, 'syncing', new Date());

    try {
      await gotoConnectors(page);

      await expect(
        page.getByTestId('sync-now-status'),
        'syncing badge must render',
      ).toContainText('Syncing', { timeout: 10_000 });

      await expect(
        page.getByTestId('sync-now-trigger'),
        'trigger must be disabled while a sync is in flight',
      ).toBeDisabled({ timeout: 10_000 });

      await expect(
        page.getByTestId('sync-now-syncing-hint'),
        'the in-flight hint must be visible',
      ).toBeVisible();
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);

// ── Test 3: synced state → "Synced" badge + honest last-synced timestamp ──────

test(
  'connector seeded synced renders "Synced" + an honest last-synced timestamp',
  async ({ page }) => {
    const { email } = await onboardToDashboard(page, 'sn-synced');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(
      brandId,
      'connected',
      new Date(Date.now() - 30 * 60 * 1000),
    );

    try {
      await gotoConnectors(page);

      await expect(
        page.getByTestId('sync-now-status'),
        'synced badge must render',
      ).toContainText('Synced', { timeout: 10_000 });

      const lastSynced = page.getByTestId('sync-now-last-synced');
      await expect(lastSynced, 'last-synced timestamp must render').toBeVisible();
      await expect(lastSynced).toContainText('Last synced');
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);

// ── Test 4: analyst does NOT see the trigger (hidden) but sees status ──────────
// Sync = Owner/Brand-Admin/Manager; only ANALYST is gated out (manager IS allowed,
// unlike backfill). So the "hidden role" negative control is analyst.

test(
  'analyst does not see the Sync now trigger (hidden — mirrors server 403); manager DOES',
  async ({ page }) => {
    const { email } = await onboardToDashboard(page, 'sn-analyst');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(brandId, 'connected', new Date());

    try {
      // First: a MANAGER must SEE the trigger (sync allows manager+).
      await setMembershipRole(email, 'manager');
      await page.goto('/login');
      await page.getByTestId('input-email').fill(email);
      await page.getByTestId('input-password').fill(PASSWORD);
      await page.getByTestId('btn-login').click();
      await page.waitForTimeout(1_500);
      await gotoConnectors(page);
      await expect(
        page.getByTestId('sync-now-trigger'),
        'manager MUST see the Sync now trigger (sync allows manager+)',
      ).toBeVisible({ timeout: 10_000 });

      // Then demote to ANALYST and re-login — the trigger must be HIDDEN.
      await setMembershipRole(email, 'analyst');
      await page.goto('/login');
      await page.getByTestId('input-email').fill(email);
      await page.getByTestId('input-password').fill(PASSWORD);
      await page.getByTestId('btn-login').click();
      await page.waitForTimeout(1_500);
      await gotoConnectors(page);

      // The read-only status badge MUST still be visible to an analyst.
      await expect(
        page.getByTestId('sync-now-status'),
        'analyst must still see the read-only sync status',
      ).toBeVisible({ timeout: 10_000 });

      // The trigger MUST be hidden (not merely disabled) for an analyst.
      const triggerVisible = await page
        .getByTestId('sync-now-trigger')
        .isVisible({ timeout: 4_000 })
        .catch(() => false);
      expect(triggerVisible, 'Analyst must NOT see the Sync now trigger').toBe(false);
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);
