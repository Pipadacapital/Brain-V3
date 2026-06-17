import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { onboardToDashboard } from './helpers/onboard';

/**
 * Live-Sync Freshness Indicator E2E — feat-shopify-live-connector, Track C (C3)
 *
 * Tests:
 *   1. connected + recent last_sync_at → "Live" pill + freshness text rendered
 *   2. connected + stale last_sync_at  → "Connected" (NOT "Live") + honest freshness
 *   3. syncing state                   → "Syncing…" pill rendered
 *   4. waiting_for_data (no sync)      → "Waiting for data" pill (honest empty)
 *
 * Architecture:
 *   - Uses onboardToDashboard to create a fresh ephemeral brand per test.
 *   - Seeds connector_instance + connector_sync_status via superuser pool (brain:brain).
 *   - Asserts data-testid="connection-live-indicator" and data-testid="connection-freshness".
 *   - "Live" pill MUST only appear for connected + recent state; stale/waiting must NOT show "Live".
 *   - NEVER touches brand 60d543dc-* — always own ephemeral brand.
 *   - Cleanup via afterEach (connector_sync_status → connector_instance delete).
 *
 * Honesty:
 *   The indicator reflects real connector_sync_status.state + last_sync_at from the DB.
 *   This spec drives the indicator deterministically via DB seed — never via a mock "Live" shortcut.
 *
 * Real-network: web :3000 + core :3001 must be running; DATABASE_URL accessible.
 */

const DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

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
 *
 * @param brandId  - the ephemeral brand to seed
 * @param syncState - connector_sync_status.state
 * @param lastSyncAt - connector_sync_status.last_sync_at (NULL = no sync yet)
 */
async function seedConnectorWithSync(
  brandId: string,
  syncState: 'connected' | 'syncing' | 'waiting_for_data' | 'error',
  lastSyncAt: Date | null,
): Promise<{ instanceId: string }> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    // Upsert connector_instance (status='connected')
    const instRes = await client.query<{ id: string }>(
      `INSERT INTO connector_instance
         (brand_id, provider, shop_domain, secret_ref, status, connected_at)
       VALUES
         ($1, 'shopify', 'e2e-livesync.myshopify.com',
          'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/e2e-livesync',
          'connected', NOW())
       ON CONFLICT (brand_id, provider) DO UPDATE
         SET status = 'connected',
             shop_domain = 'e2e-livesync.myshopify.com',
             updated_at = NOW()
       RETURNING id`,
      [brandId],
    );
    const instanceId = instRes.rows[0]!.id;

    // Upsert connector_sync_status.
    // 0025 added UNIQUE (brand_id, connector_instance_id) enabling ON CONFLICT upsert.
    await client.query(
      `INSERT INTO connector_sync_status
         (brand_id, connector_instance_id, state, last_sync_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (brand_id, connector_instance_id)
         DO UPDATE SET state = $3, last_sync_at = $4, updated_at = NOW()`,
      [brandId, instanceId, syncState, lastSyncAt],
    );

    return { instanceId };
  } finally {
    await client.end();
  }
}

/** Remove seeded connector rows (cascade: sync_status → cursor → instance). */
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

// ── Test 1: connected + recent last_sync_at → "Live" indicator ───────────────

test(
  'connected connector with recent last_sync_at renders "Live" pill + freshness text',
  async ({ page }) => {
    /**
     * Honesty assertion:
     *   Seeds state='connected' + last_sync_at=NOW() (< 5 min threshold).
     *   → connection-live-indicator must say "Live".
     *   → connection-freshness must show "Live · synced just now" (or similar).
     *
     * REVERT-RED: Revert the isLive() check in connection-status-card.tsx to always return false
     *   → "Live" text disappears → this test goes RED.
     */
    const { email } = await onboardToDashboard(page, 'ls-live');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(brandId, 'connected', new Date());

    try {
      // Navigate to dashboard — ConnectionStatusCard reads from /v1/dashboard/connection-status
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard/);

      // Wait for card to render (it's lazy-loaded via TanStack Query)
      await expect(page.getByTestId('connection-status-card')).toBeVisible({ timeout: 10_000 });

      // Live indicator must be present
      const indicator = page.getByTestId('connection-live-indicator');
      await expect(indicator).toBeVisible({ timeout: 10_000 });

      // Must show "Live" text (not "Connected" or "Syncing")
      await expect(indicator, '"Live" text must appear in the pill').toContainText('Live');

      // Freshness text must be present (e.g. "Live · synced just now")
      const freshness = page.getByTestId('connection-freshness');
      await expect(freshness).toBeVisible({ timeout: 10_000 });
      const freshnessText = await freshness.textContent();
      expect(freshnessText, 'Freshness text must reference "Live"').toMatch(/[Ll]ive/);

      // A11y: role="status" on the indicator
      const role = await indicator.getAttribute('role');
      expect(role, 'indicator must have role="status"').toBe('status');

      // aria-label must mention Live
      const ariaLabel = await indicator.getAttribute('aria-label');
      expect(ariaLabel, 'aria-label must describe Live status').toMatch(/[Ll]ive/);
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);

// ── Test 2: connected + stale last_sync_at → honest "Connected" (NOT "Live") ──

test(
  'connected connector with stale last_sync_at renders "Connected" (NOT "Live") + honest freshness',
  async ({ page }) => {
    /**
     * Honesty assertion:
     *   Seeds state='connected' + last_sync_at=10 hours ago (>> 5 min threshold).
     *   → connection-live-indicator must NOT say "Live".
     *   → connection-freshness must show "Last synced X hours ago".
     *
     * This is the core no-fake-Live assertion. The indicator must be honest when data is stale.
     *
     * REVERT-RED: Remove the LIVE_THRESHOLD_MS check to always show "Live" for connected state
     *   → "Live" appears for stale data → this test goes RED.
     */
    const staleDate = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10 hours ago
    const { email } = await onboardToDashboard(page, 'ls-stale');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(brandId, 'connected', staleDate);

    try {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard/);

      await expect(page.getByTestId('connection-status-card')).toBeVisible({ timeout: 10_000 });

      const indicator = page.getByTestId('connection-live-indicator');
      await expect(indicator).toBeVisible({ timeout: 10_000 });

      // Must NOT show "Live" (stale data must be honest)
      const indicatorText = await indicator.textContent();
      expect(indicatorText, 'Stale connector must NOT show "Live"').not.toMatch(/\bLive\b/);

      // Must show "Connected" for the connected state (not "Live")
      await expect(
        indicator,
        'Stale connector must show "Connected" pill (not Live)',
      ).toContainText('Connected');

      // Freshness text must be present and say "Last synced" (not "Live ·")
      const freshness = page.getByTestId('connection-freshness');
      await expect(freshness).toBeVisible({ timeout: 10_000 });
      const freshnessText = await freshness.textContent();
      expect(
        freshnessText,
        'Stale freshness text must say "Last synced"',
      ).toMatch(/[Ll]ast synced/);

      // Must NOT say "Live ·" in the freshness text
      expect(
        freshnessText,
        'Stale freshness text must NOT say "Live"',
      ).not.toMatch(/\bLive\b/);
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);

// ── Test 3: syncing state → "Syncing…" pill ───────────────────────────────────

test(
  'syncing connector renders "Syncing…" animated pill',
  async ({ page }) => {
    /**
     * Seeds state='syncing' + last_sync_at=5 min ago.
     * → connection-live-indicator must say "Syncing".
     */
    const lastSync = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    const { email } = await onboardToDashboard(page, 'ls-syncing');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(brandId, 'syncing', lastSync);

    try {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard/);

      await expect(page.getByTestId('connection-status-card')).toBeVisible({ timeout: 10_000 });

      const indicator = page.getByTestId('connection-live-indicator');
      await expect(indicator).toBeVisible({ timeout: 10_000 });

      // Must show "Syncing" text
      await expect(indicator, '"Syncing" text must appear').toContainText('Syncing');

      // Must NOT show "Live" during syncing state
      const indicatorText = await indicator.textContent();
      expect(indicatorText, 'Syncing pill must not say "Live"').not.toMatch(/\bLive\b/);

      // role="status" for a11y
      const role = await indicator.getAttribute('role');
      expect(role, 'syncing indicator must have role="status"').toBe('status');
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);

// ── Test 4: waiting_for_data (no sync) → honest empty state ──────────────────

test(
  'waiting_for_data connector renders "Waiting for data" pill — honest no-sync state',
  async ({ page }) => {
    /**
     * Seeds state='waiting_for_data' + last_sync_at=NULL.
     * → connection-live-indicator must say "Waiting for data".
     * → connection-freshness must say "No sync yet".
     * → Must NOT say "Live" (honesty gate).
     */
    const { email } = await onboardToDashboard(page, 'ls-waiting');
    const brandId = await getBrandId(email);
    const { instanceId } = await seedConnectorWithSync(brandId, 'waiting_for_data', null);

    try {
      await page.goto('/dashboard');
      await expect(page).toHaveURL(/\/dashboard/);

      await expect(page.getByTestId('connection-status-card')).toBeVisible({ timeout: 10_000 });

      const indicator = page.getByTestId('connection-live-indicator');
      await expect(indicator).toBeVisible({ timeout: 10_000 });

      // Must show "Waiting for data" text
      await expect(indicator, '"Waiting for data" text must appear').toContainText('Waiting for data');

      // Must NOT say "Live" — this is the honesty gate for the no-sync case
      const indicatorText = await indicator.textContent();
      expect(indicatorText, 'Waiting-for-data pill must never say "Live"').not.toMatch(/\bLive\b/);

      // Freshness text for waiting_for_data with null last_sync_at
      const freshness = page.getByTestId('connection-freshness');
      await expect(freshness).toBeVisible({ timeout: 10_000 });
      const freshnessText = await freshness.textContent();
      expect(
        freshnessText,
        'Waiting-for-data freshness must say "No sync yet"',
      ).toMatch(/[Nn]o sync/);
    } finally {
      await cleanupConnector(instanceId);
    }
  },
);
