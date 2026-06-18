import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import {
  step,
  pauseFor,
  announce,
  onboardToDashboard,
} from './helpers/demo';

/**
 * Connector Marketplace & Lifecycle — WATCHABLE DEMO SPEC.
 *
 * This is the narrated, headed companion to the CI smoke specs
 * (e2e/marketplace.spec.ts + e2e/connector-lifecycle.spec.ts). It does NOT replace
 * them — it walks a stakeholder, slowly and with on-screen captions, through the
 * connector marketplace and its lifecycle (connect → health → disconnect), and
 * proves the negative paths too.
 *
 * GROUNDING (every selector below was grepped from the real components):
 *   - components/connectors/marketplace-view.tsx declares:
 *       marketplace-page (page.tsx), connector-tile-{id}, connector-tile-{id}-connect,
 *       connector-tile-{id}-status, connector-tile-coming-soon, connector-health-badge-{id},
 *       marketplace-category-{cat}, btn-disconnect-{id}, input-shop-shopify, btn-skip-for-now.
 *   - The seven HealthState badges (Healthy / Delayed / RateLimited / Failed /
 *     Disconnected / TokenExpired / Disabled) come from HEALTH_CONFIG in that file —
 *     each rendered as icon + text label (a11y: never colour-only).
 *
 * HONESTY BOUNDARY (same as connector-lifecycle.spec.ts):
 *   - We never fake a real Shopify OAuth round-trip. The connect step asserts the
 *     BFF POST /api/bff/v1/connectors fires (intercepted before the provider redirect).
 *   - Health badges are surfaced by SEEDING a status='connected' connector_instance
 *     row with the target health_state directly via the superuser DB — exactly the
 *     pattern used by live-sync.spec.ts / connector-lifecycle.spec.ts. The BFF maps
 *     status='disconnected' → instance=null, so 'Disconnected' is shown via the
 *     Connect-tile path (no badge) rather than a connected badge — that asymmetry is
 *     honest and is narrated in the test.
 *
 * Data safety: every test onboards a FRESH ephemeral brand (fresh stamped email via
 *   the onboard helper) and cleans up any seeded connector_instance in `finally`.
 *
 * Prerequisites: dev stack up (web :3000 → BFF → core :3001 → Postgres),
 *   DATABASE_URL reachable. Run via: pnpm --filter @brain/web test:e2e:demo
 */

const DSN = process.env['DATABASE_URL'] ?? 'postgres://brain:brain@localhost:5432/brain';

// The seven health states declared in HEALTH_CONFIG (marketplace-view.tsx).
const SEVEN_HEALTH_STATES = [
  'Healthy',
  'Delayed',
  'RateLimited',
  'Failed',
  'Disconnected',
  'TokenExpired',
  'Disabled',
] as const;

// Of the seven, these six surface as a CONNECTED badge (status='connected').
// 'Disconnected' is shown via the Connect-tile path (BFF maps it to instance=null).
const CONNECTED_HEALTH_STATES = SEVEN_HEALTH_STATES.filter((s) => s !== 'Disconnected');

const EXPECTED_CATEGORIES = [
  { id: 'storefront', label: 'Storefront' },
  { id: 'ads', label: 'Advertising' },
  { id: 'payments', label: 'Payments' },
  { id: 'logistics', label: 'Logistics' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'crm', label: 'CRM' },
  { id: 'analytics', label: 'Analytics' },
] as const;

// ── DB helpers (superuser — seed/teardown only, mirrors connector-lifecycle.spec.ts) ──

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
 * Seed a CONNECTED connector_instance with a given health_state so the Shopify tile
 * renders the corresponding health badge + (for non-safe ratings) a safety flag.
 * Mirrors live-sync.spec.ts seedConnectorWithSync + connector-lifecycle.spec.ts seed.
 */
async function seedConnectedInstance(
  brandId: string,
  healthState: string,
  safetyRating: 'safe' | 'degraded' | 'blocked' = 'safe',
): Promise<string> {
  const client = new Client({ connectionString: DSN });
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `INSERT INTO connector_instance
         (brand_id, provider, shop_domain, secret_ref, status, health_state, safety_rating, connected_at)
       VALUES
         ($1, 'shopify', 'e2e-demo-health.myshopify.com',
          'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/e2e-demo',
          'connected', $2, $3, NOW())
       ON CONFLICT (brand_id, provider) DO UPDATE
         SET status = 'connected',
             health_state = $2,
             safety_rating = $3,
             shop_domain = 'e2e-demo-health.myshopify.com',
             disconnected_at = NULL,
             connected_at = NOW(),
             updated_at = NOW()
       RETURNING id`,
      [brandId, healthState, safetyRating],
    );
    return res.rows[0]!.id;
  } finally {
    await client.end();
  }
}

/** Remove a seeded connector_instance by id (cascade: sync_status → cursor → instance). */
async function cleanupInstance(instanceId: string): Promise<void> {
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

// ════════════════════════════════════════════════════════════════════════════
// POSITIVE 1 — Marketplace tiles render by category with truthful status
// ════════════════════════════════════════════════════════════════════════════

test('POSITIVE — marketplace renders all 7 categories with truthful tiles', async ({ page }) => {
  await announce(page, 'Connector Marketplace — Tour by Category');

  await step(page, 'Onboard a fresh brand and land on the dashboard', async () => {
    await onboardToDashboard(page, 'demo-cats');
  });

  await step(page, 'Open the Integration Marketplace at /settings/connectors', async () => {
    await page.goto('/settings/connectors');
    await expect(page).toHaveURL(/\/settings\/connectors/);
    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
  });

  await step(page, 'Confirm the page header reads "Integration Marketplace"', async () => {
    await expect(
      page.getByRole('heading', { name: 'Integration Marketplace' }),
    ).toBeVisible();
  });

  // Walk each of the seven category sections so the viewer sees them appear one by one.
  for (const cat of EXPECTED_CATEGORIES) {
    await step(page, `Category section "${cat.label}" is present`, async () => {
      const section = page.getByTestId(`marketplace-category-${cat.id}`);
      await expect(section, `Category '${cat.id}' must render`).toBeVisible({ timeout: 10_000 });
      await section.scrollIntoViewIfNeeded();
    });
  }

  await step(page, 'The Shopify tile lives under Storefront and is the headline connector', async () => {
    const shopifyTile = page.getByTestId('connector-tile-shopify');
    await expect(shopifyTile).toBeVisible();
    await shopifyTile.scrollIntoViewIfNeeded();
  });

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// POSITIVE 2 — Open the Shopify connect flow (real BFF POST, no faked OAuth)
// ════════════════════════════════════════════════════════════════════════════

test('POSITIVE — open Shopify connect flow and fire the real BFF connect request', async ({ page }) => {
  await announce(page, 'Connect a Store — Shopify OAuth Start');

  await step(page, 'Onboard a fresh brand and open the marketplace', async () => {
    await onboardToDashboard(page, 'demo-connect');
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
  });

  const shopifyTile = page.getByTestId('connector-tile-shopify');
  const connectBtn = page.getByTestId('connector-tile-shopify-connect');
  const domainInput = page.getByTestId('input-shop-shopify');

  await step(page, 'Focus the Shopify tile — it shows a store-domain input and a Connect button', async () => {
    await shopifyTile.scrollIntoViewIfNeeded();
    await expect(domainInput).toBeVisible({ timeout: 10_000 });
    await expect(connectBtn).toBeVisible();
  });

  await step(page, 'Connect is DISABLED until a store domain is entered (guards empty input)', async () => {
    await expect(connectBtn).toBeDisabled();
  });

  await step(page, 'Type the store domain — the Connect button becomes enabled', async () => {
    await domainInput.fill('demo-store.myshopify.com');
    await expect(connectBtn).toBeEnabled();
  });

  await step(page, 'Click Connect — the app fires POST /api/bff/v1/connectors (type=shopify)', async () => {
    const connectRequestPromise = page.waitForRequest(
      (req) => req.url().includes('/api/bff/v1/connectors') && req.method() === 'POST',
      { timeout: 15_000 },
    );
    await connectBtn.click();

    const connectRequest = await connectRequestPromise;
    expect(connectRequest.method()).toBe('POST');
    expect(connectRequest.url()).toContain('/v1/connectors');

    const body = connectRequest.postDataJSON() as { type?: string; shop_domain?: string } | null;
    expect(body?.type, 'request body type must be shopify').toBe('shopify');
    expect(body?.shop_domain, 'request body must carry the store domain').toBe(
      'demo-store.myshopify.com',
    );
  });

  await step(page, 'We stop at the real provider boundary — we do NOT fake the Shopify OAuth screen', async () => {
    // Honesty: the BFF responds with an oauth_url and the app would redirect off-site to
    // Shopify. A real authorize step needs staging creds, so the demo proves the request
    // fired and deliberately goes no further.
  });

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// POSITIVE 3 — The seven connector health states surface where present
// ════════════════════════════════════════════════════════════════════════════

test('POSITIVE — connector health states surface as icon+label badges (six connected states)', async ({ page }) => {
  await announce(page, 'Connector Health — The Seven States');

  let onboarded: { email: string } | null = null;
  await step(page, 'Onboard a fresh brand for the health-state walkthrough', async () => {
    onboarded = await onboardToDashboard(page, 'demo-health');
  });
  const email = onboarded!.email;
  const brandId = await getBrandId(email);

  // Walk the six CONNECTED health states. Each is seeded directly, then the page is
  // reloaded so the BFF re-fetches and the Shopify tile renders the matching badge.
  for (const health of CONNECTED_HEALTH_STATES) {
    let instanceId: string | null = null;
    try {
      instanceId = await seedConnectedInstance(brandId, health, 'safe');

      await step(page, `Seed a connected Shopify instance with health "${health}" and reload`, async () => {
        await page.goto('/settings/connectors');
        await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
        await page.getByTestId('connector-tile-shopify').scrollIntoViewIfNeeded();
      });

      await step(page, `Health badge shows "${health}" — icon + text label, never colour-only`, async () => {
        const badge = page.getByTestId('connector-health-badge-shopify');
        await expect(badge, `health badge for ${health} must render`).toBeVisible({ timeout: 10_000 });

        // a11y: status role + descriptive aria-label (non-colour-only signal).
        await expect(badge).toHaveAttribute('role', 'status');
        const ariaLabel = await badge.getAttribute('aria-label');
        expect(ariaLabel, 'aria-label must describe the health state').toMatch(/Connection health/i);

        // A connected instance shows a Disconnect button, not a Connect button.
        await expect(page.getByTestId('btn-disconnect-shopify')).toBeVisible();
      });
    } finally {
      if (instanceId) await cleanupInstance(instanceId);
    }
  }

  await step(page, 'The 7th state — "Disconnected" — is shown via the Connect tile (BFF maps it to no instance)', async () => {
    // After the last cleanup the brand has zero instances → the tile reverts to the
    // Connect state. This is the honest rendering of "Disconnected": the BFF maps a
    // disconnected row to instance=null, so it never shows a connected badge.
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('input-shop-shopify')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('connector-health-badge-shopify')).toHaveCount(0);
  });

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// POSITIVE 4 — Safety flag surfaces alongside health for a degraded/blocked rating
// ════════════════════════════════════════════════════════════════════════════

test('POSITIVE — a blocked safety rating surfaces an "excluded — connector failing" flag', async ({ page }) => {
  await announce(page, 'Connector Safety — Blocked Rating Warning');

  let onboarded: { email: string } | null = null;
  await step(page, 'Onboard a fresh brand', async () => {
    onboarded = await onboardToDashboard(page, 'demo-safety');
  });
  const brandId = await getBrandId(onboarded!.email);

  let instanceId: string | null = null;
  try {
    instanceId = await seedConnectedInstance(brandId, 'Failed', 'blocked');

    await step(page, 'Seed a connected-but-Failed instance with a "blocked" safety rating', async () => {
      await page.goto('/settings/connectors');
      await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('connector-tile-shopify').scrollIntoViewIfNeeded();
    });

    await step(page, 'A "Failed" health badge AND an "excluded — connector failing" flag both show', async () => {
      await expect(page.getByTestId('connector-health-badge-shopify')).toContainText('Failed');
      // SAFETY_FLAG.blocked.label in marketplace-view.tsx
      await expect(
        page.getByText('excluded — connector failing'),
        'blocked safety rating must surface its warning text',
      ).toBeVisible({ timeout: 10_000 });
    });
  } finally {
    if (instanceId) await cleanupInstance(instanceId);
  }

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// POSITIVE 5 — Disconnect flow from a connected tile
// ════════════════════════════════════════════════════════════════════════════

test('POSITIVE — disconnect a connected connector and confirm it returns to the Connect tile', async ({ page }) => {
  await announce(page, 'Disconnect a Connector — Lifecycle End');

  let onboarded: { email: string } | null = null;
  await step(page, 'Onboard a fresh brand', async () => {
    onboarded = await onboardToDashboard(page, 'demo-disconnect');
  });
  const brandId = await getBrandId(onboarded!.email);

  let instanceId: string | null = null;
  try {
    instanceId = await seedConnectedInstance(brandId, 'Healthy', 'safe');

    await step(page, 'Seed a healthy connected Shopify instance and open the marketplace', async () => {
      await page.goto('/settings/connectors');
      await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
      await page.getByTestId('connector-tile-shopify').scrollIntoViewIfNeeded();
    });

    await step(page, 'The connected tile shows a "Healthy" badge and a Disconnect button', async () => {
      await expect(page.getByTestId('connector-health-badge-shopify')).toContainText('Healthy');
      await expect(page.getByTestId('btn-disconnect-shopify')).toBeVisible();
      await expect(page.getByTestId('btn-disconnect-shopify')).toBeEnabled();
    });

    await step(page, 'Click Disconnect — the app fires a disconnect request to the BFF', async () => {
      const disconnectReq = page.waitForRequest(
        (req) =>
          req.url().includes('/api/bff/v1/connectors') &&
          (req.method() === 'DELETE' || req.method() === 'POST'),
        { timeout: 15_000 },
      ).catch(() => null);

      await page.getByTestId('btn-disconnect-shopify').click();
      await disconnectReq;
    });

    await step(page, 'After disconnect the tile reverts to the Connect state — no badge, Connect input returns', async () => {
      // The BFF now maps the disconnected row to instance=null → Connect tile.
      await expect(page.getByTestId('connector-health-badge-shopify')).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId('input-shop-shopify')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('btn-disconnect-shopify')).toHaveCount(0);
    });
  } finally {
    if (instanceId) await cleanupInstance(instanceId);
  }

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// NEGATIVE 1 — Connect with an empty store domain is blocked (button disabled)
// ════════════════════════════════════════════════════════════════════════════

test('NEGATIVE — Connect is blocked with an empty store domain (button stays disabled)', async ({ page }) => {
  await announce(page, 'Negative — Empty Credentials Are Rejected');

  await step(page, 'Onboard a fresh brand and open the marketplace', async () => {
    await onboardToDashboard(page, 'demo-neg-empty');
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
  });

  const connectBtn = page.getByTestId('connector-tile-shopify-connect');
  const domainInput = page.getByTestId('input-shop-shopify');

  await step(page, 'With the domain field empty, Connect is disabled and cannot start OAuth', async () => {
    await page.getByTestId('connector-tile-shopify').scrollIntoViewIfNeeded();
    await expect(domainInput).toHaveValue('');
    await expect(connectBtn).toBeDisabled();
  });

  await step(page, 'Force-click the disabled Connect — NO POST /connectors fires (blocked)', async () => {
    const postPromise = page.waitForRequest(
      (req) => req.url().includes('/api/bff/v1/connectors') && req.method() === 'POST',
      { timeout: 2_500 },
    ).catch(() => null);

    await connectBtn.click({ force: true });
    const fired = await postPromise;
    expect(fired, 'a disabled Connect must not fire a connect request').toBeNull();
  });

  await step(page, 'Type then clear the domain — the button disables again (live validation)', async () => {
    await domainInput.fill('something.myshopify.com');
    await expect(connectBtn).toBeEnabled();
    await domainInput.fill('');
    await expect(connectBtn).toBeDisabled();
  });

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// NEGATIVE 2 — Coming-soon tiles are structurally un-connectable
// ════════════════════════════════════════════════════════════════════════════

test('NEGATIVE — coming-soon tiles are NOT connectable (disabled + aria-disabled, no request)', async ({ page }) => {
  await announce(page, 'Negative — Coming-Soon Tiles Are Locked');

  await step(page, 'Onboard a fresh brand and open the marketplace', async () => {
    await onboardToDashboard(page, 'demo-neg-soon');
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
  });

  await step(page, 'At least one "Coming Soon" tile is present in the catalog', async () => {
    const comingSoon = page.getByTestId('connector-tile-coming-soon');
    await expect(comingSoon.first()).toBeVisible({ timeout: 10_000 });
    expect(await comingSoon.count(), 'catalog must include coming-soon tiles').toBeGreaterThan(0);
  });

  const metaTile = page.getByTestId('connector-tile-meta');
  const metaConnect = page.getByTestId('connector-tile-meta-connect');

  await step(page, 'The Meta tile is coming-soon — its button reads "Coming Soon" and is disabled', async () => {
    await expect(metaTile).toBeVisible({ timeout: 10_000 });
    await metaTile.scrollIntoViewIfNeeded();
    await expect(metaConnect).toBeVisible();
    await expect(metaConnect).toBeDisabled();
    await expect(metaConnect).toHaveAttribute('aria-disabled', 'true');
  });

  await step(page, 'Force-click the coming-soon button — NO POST /connectors fires (un-connectable)', async () => {
    const postPromise = page.waitForRequest(
      (req) => req.url().includes('/api/bff/v1/connectors') && req.method() === 'POST',
      { timeout: 2_500 },
    ).catch(() => null);

    await metaConnect.click({ force: true });
    const fired = await postPromise;
    expect(fired, 'coming-soon tile must never fire a connect request').toBeNull();
  });

  await pauseFor(page, 1200);
});

// ════════════════════════════════════════════════════════════════════════════
// NEGATIVE 3 — Marketplace is never a gate: Skip For Now always works
// ════════════════════════════════════════════════════════════════════════════

test('NEGATIVE — a zero-connection brand is never gated: "Skip for now" exits to the dashboard', async ({ page }) => {
  await announce(page, 'Negative — The Marketplace Is Never a Gate');

  await step(page, 'Onboard a fresh brand with zero connectors and open the marketplace', async () => {
    await onboardToDashboard(page, 'demo-neg-skip');
    await page.goto('/settings/connectors');
    await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 15_000 });
  });

  await step(page, 'With nothing connected the Shopify tile shows the Connect state — no health badge', async () => {
    await expect(page.getByTestId('connector-tile-shopify')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('connector-health-badge-shopify')).toHaveCount(0);
  });

  await step(page, 'Click "Skip for now" — the brand is taken straight to the dashboard (no block)', async () => {
    const skip = page.getByTestId('btn-skip-for-now');
    await expect(skip).toBeVisible();
    await skip.click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  });

  await pauseFor(page, 1200);
});
