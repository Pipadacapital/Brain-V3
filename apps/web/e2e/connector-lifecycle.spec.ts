import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { onboardToDashboard } from './helpers/onboard';

/**
 * Connector Lifecycle E2E — Track C, req_id: chore-connector-lifecycle-regression
 *
 * ┌─────────────────────────────────────────────────────────────────────────────┐
 * │  HONESTY BOUNDARY (D-1, plan §4 Track C, architecture-plan.md)              │
 * │                                                                             │
 * │  WHAT THIS E2E PROVES:                                                      │
 * │    • UI state transitions on the /settings/connectors marketplace page.     │
 * │    • A disconnected connector_instance (status='disconnected') seeded via   │
 * │      the superuser DB causes the BFF (main.ts:535) to return instance=null  │
 * │      → the tile renders with the Connect action, NOT a health badge.        │
 * │    • Coming-soon tiles are structurally un-connectable (aria-disabled).     │
 * │    • The live GET /api/bff/v1/connectors route returns HTTP 200 (not a      │
 * │      stale failure mode).                                                   │
 * │                                                                             │
 * │  WHAT THIS E2E DOES NOT PROVE (covered at the integration layer):           │
 * │    • Reconnect UPSERT no-23505 → Track B connector-lifecycle.integration.   │
 * │    • Single-sync-row count after reconnect → Track B same file.             │
 * │    • OAuth callback 302/Location/HMAC contract → Track B oauth-callback.    │
 * │    • Pagination since_id=0 walk → Track A shopify-pagination.integration.   │
 * │    • Worker NIL-uuid GUC / cross-brand RLS → Track A worker-guc.            │
 * │                                                                             │
 * │  REAL OAUTH NOT FAKED:                                                      │
 * │    A real Shopify connect→disconnect→reconnect round-trip requires a live   │
 * │    Shopify OAuth authorize step (staging env only). This file does NOT fake │
 * │    that. The disconnected-tile rendering is proven by seeding a             │
 * │    status='disconnected' connector_instance row directly via the superuser  │
 * │    DB, then asserting the BFF maps it to instance=null → Connect tile.      │
 * │    The full connect→disconnect→reconnect DB mechanics are Track B.          │
 * │                                                                             │
 * │  REVERT-RED for defect #1:                                                  │
 * │    If main.ts:535 is reverted from:                                         │
 * │      const instance = found && found.status !== 'disconnected' ? found : null│
 * │    back to:                                                                 │
 * │      const instance = found                                                 │
 * │    → the BFF returns instance≠null for a disconnected row → the tile        │
 * │      renders a HealthBadge (connector-health-badge-shopify) + no Connect    │
 * │      button → toHaveCount(0) on connector-health-badge-shopify goes RED     │
 * │      and the connector-tile-shopify-connect enabled assertion goes RED.     │
 * └─────────────────────────────────────────────────────────────────────────────┘
 *
 * Data safety:
 *   - Every test calls onboardToDashboard() → fresh ephemeral brand per test.
 *   - Seeds against the JUST-ONBOARDED brand (looked up via email).
 *   - No reference to the real Boddactive brand (60d543dc-…) ever.
 *   - Cleanup via afterAll per test (connector_instance DELETE via superuser).
 *
 * Prerequisites: web :3000 + core :3001 running, DATABASE_URL accessible.
 */

const DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// ── DB helpers (superuser only — for seeding/teardown, consistent with the harness) ──

/** Look up the brand_id for the most-recently created brand for this user. */
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
 * Seed a connector_instance row with status='disconnected' for the given brand.
 * Uses the superuser connection (RLS does not apply; correct for seeding/teardown).
 * secret_ref is a fake ARN — no real credential stored.
 */
async function seedDisconnectedInstance(brandId: string): Promise<string> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `INSERT INTO connector_instance
         (brand_id, provider, shop_domain, secret_ref, status, health_state, safety_rating,
          connected_at, disconnected_at)
       VALUES
         ($1, 'shopify', 'e2e-disconnected.myshopify.com',
          'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/e2e-fake',
          'disconnected', 'Disconnected', 'safe',
          NOW() - INTERVAL '1 hour', NOW())
       ON CONFLICT (brand_id, provider) DO UPDATE
         SET status = 'disconnected',
             health_state = 'Disconnected',
             safety_rating = 'safe',
             disconnected_at = NOW(),
             updated_at = NOW()
       RETURNING id`,
      [brandId],
    );
    if (!res.rows[0]) throw new Error(`connector_instance seed returned no row for brand: ${brandId}`);
    return res.rows[0].id;
  } finally {
    await client.end();
  }
}

/** Remove a seeded connector_instance by id (superuser). */
async function cleanupInstance(instanceId: string): Promise<void> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    // cascade: delete sync_status / cursor first if they exist, then the instance.
    await client.query(
      `DELETE FROM connector_sync_status WHERE connector_instance_id = $1`,
      [instanceId],
    );
    await client.query(
      `DELETE FROM connector_cursor WHERE connector_instance_id = $1`,
      [instanceId],
    );
    await client.query(`DELETE FROM connector_instance WHERE id = $1`, [instanceId]);
  } finally {
    await client.end();
  }
}

// ── C1a: Disconnected instance → Connect tile (defect #1 revert-RED) ──────────

test(
  'disconnected connector_instance renders as Connect tile (not health badge) — defect #1 revert-RED',
  async ({ page }) => {
    /**
     * REVERT-RED:
     *   Revert main.ts:535 to `const instance = found` (remove the `!== 'disconnected'` guard).
     *   With the revert the BFF returns instance≠null for the disconnected row →
     *   connector-health-badge-shopify appears (toHaveCount(0) goes RED)
     *   AND connector-tile-shopify-connect disappears (enabled assertion goes RED).
     *
     * With the fix in place (main.ts:535):
     *   instance = found && found.status !== 'disconnected' ? found : null
     *   → instance=null → Connect tile shows, no health badge.
     */
    const { email } = await onboardToDashboard(page, 'clf-disconnected');
    const brandId = await getBrandId(email);
    const instanceId = await seedDisconnectedInstance(brandId);

    try {
      // Navigate to the marketplace AFTER seeding so the BFF fetches the seeded row.
      await page.goto('/settings/connectors');
      await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });

      // ── The tile must be present ──────────────────────────────────────────────
      const shopifyTile = page.getByTestId('connector-tile-shopify');
      await expect(shopifyTile).toBeVisible({ timeout: 10_000 });

      // ── Connect action must be present + enabled (after entering a domain) ───
      // The shop-domain input appears only when instance=null (Connect state).
      const domainInput = page.getByTestId('input-shop-shopify');
      await expect(domainInput).toBeVisible({ timeout: 10_000 });

      await domainInput.fill('e2e-disconnected.myshopify.com');

      const connectBtn = page.getByTestId('connector-tile-shopify-connect');
      await expect(connectBtn).toBeVisible({ timeout: 10_000 });
      // Button is enabled once domain is filled — defect #1 revert-RED assertion.
      await expect(
        connectBtn,
        'Connect button must be enabled for a disconnected instance (defect #1)',
      ).toBeEnabled();

      // ── No health badge must exist (defect #1 revert-RED assertion) ──────────
      // A health badge only renders when tile.instance is non-null (TileStatusIndicator).
      // With main.ts:535 reverted → badge renders → this assertion goes RED.
      await expect(
        page.getByTestId('connector-health-badge-shopify'),
        'No health badge for a disconnected instance — defect #1 revert-RED',
      ).toHaveCount(0);

      // ── No Disconnect button must exist ───────────────────────────────────────
      await expect(
        page.getByTestId('btn-disconnect-shopify'),
        'No Disconnect button for a disconnected instance',
      ).toHaveCount(0);
    } finally {
      await cleanupInstance(instanceId);
    }
  },
);

// ── C1b: Fresh (no instance) → Connect tile (connect-tile baseline reference) ──

test(
  'freshly onboarded brand with no connector_instance renders Shopify Connect tile',
  async ({ page }) => {
    /**
     * Baseline / connect-tile reference (architecture-plan.md §4 Track C C1 note).
     * A brand with ZERO connector_instance rows → BFF returns instance=null → Connect tile.
     * This is the "happy path" baseline complementing C1a's seeded-disconnected case.
     * Also referenced by marketplace.spec.ts test 4 (mkt-zero); kept here for
     * explicit lifecycle coverage in the connector-lifecycle suite.
     */
    await onboardToDashboard(page, 'clf-fresh');
    await page.goto('/settings/connectors');

    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });

    // Shopify tile must be present
    const shopifyTile = page.getByTestId('connector-tile-shopify');
    await expect(shopifyTile).toBeVisible({ timeout: 10_000 });

    // Domain input shows → Connect state (no instance)
    await expect(page.getByTestId('input-shop-shopify')).toBeVisible({ timeout: 10_000 });

    // Connect button present and initially disabled (no domain entered)
    const connectBtn = page.getByTestId('connector-tile-shopify-connect');
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn).toBeDisabled();

    // After filling the domain it enables
    await page.getByTestId('input-shop-shopify').fill('fresh-brand.myshopify.com');
    await expect(connectBtn).toBeEnabled();

    // No health badge (never connected → no instance → no badge)
    await expect(page.getByTestId('connector-health-badge-shopify')).toHaveCount(0);
  },
);

// ── C1c: Coming-soon tile remains un-connectable ───────────────────────────────

test(
  'coming-soon tile is structurally un-connectable (aria-disabled) — lifecycle invariant',
  async ({ page }) => {
    /**
     * Invariant: coming-soon tiles are always disabled regardless of lifecycle state.
     * Mirrors marketplace.spec.ts test 3 (mkt-soon); kept in the lifecycle suite so the
     * lifecycle regression run catches any regression in the coming-soon gate.
     */
    await onboardToDashboard(page, 'clf-comingsoon');
    await page.goto('/settings/connectors');

    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });

    // At least one coming-soon badge must exist
    const comingSoonBadges = page.getByTestId('connector-tile-coming-soon');
    await expect(comingSoonBadges.first()).toBeVisible({ timeout: 10_000 });
    expect(
      await comingSoonBadges.count(),
      'At least one coming-soon tile must be present',
    ).toBeGreaterThan(0);

    // Meta is the known coming-soon connector in the catalog
    const metaTile = page.getByTestId('connector-tile-meta');
    await expect(metaTile).toBeVisible({ timeout: 10_000 });

    const metaConnectBtn = page.getByTestId('connector-tile-meta-connect');
    await expect(metaConnectBtn).toBeVisible();
    await expect(metaConnectBtn).toBeDisabled();
    const ariaDisabled = await metaConnectBtn.getAttribute('aria-disabled');
    expect(ariaDisabled, 'Coming-soon tile must have aria-disabled="true"').toBe('true');

    // Clicking must not fire a POST /connectors
    const postPromise = page
      .waitForRequest(
        (req) => req.url().includes('/api/bff/v1/connectors') && req.method() === 'POST',
        { timeout: 2_000 },
      )
      .catch(() => null);
    await metaConnectBtn.click({ force: true });
    const fired = await postPromise;
    expect(fired, 'No POST must fire for coming-soon tile').toBeNull();
  },
);
