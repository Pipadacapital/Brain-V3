import { test, expect } from '@playwright/test';
import { onboardToDashboard } from './helpers/onboard';

/**
 * Integration Marketplace E2E — feat-connector-marketplace B4.
 *
 * Tests:
 *   1. All 7 categories render with truthful tiles.
 *   2. A Coming-Soon tile is present and NOT connectable (no connect action / disabled).
 *   3. The marketplace renders for a freshly onboarded brand with zero connections.
 *   4. An OAuth tile's Connect button is present; a POST /api/bff/v1/connectors fires
 *      when connect is initiated with a shop domain entered.
 *   5. Skip For Now navigates to dashboard without error.
 *
 * Architecture:
 *   - Uses the onboardToDashboard helper (skip integrations via btn-skip-integrations).
 *   - Asserts against data-testid attributes declared in MarketplaceView (B1).
 *   - Coming-soon tiles must have aria-disabled="true" and no data-testid connect button
 *     that is enabled (or the button itself must be disabled).
 *   - OAuth connect asserts the POST to /api/bff/v1/connectors fires (intercepts the
 *     fetch — does NOT follow the Shopify OAuth redirect which needs staging env).
 *
 * Real-network: both servers must be running (web :3000, core :3001).
 * Rate-limit keys cleared by global-setup.ts.
 */

const EXPECTED_CATEGORIES = [
  'storefront',
  'ads',
  'payments',
  'logistics',
  'messaging',
  'crm',
  'analytics',
] as const;

// ── Test 1: All 7 categories render ─────────────────────────────────────────

test('marketplace renders all 7 categories with tiles', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-cats');
  await page.goto('/settings/connectors');

  // Page wrapper
  await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 10_000 });

  // All 7 category sections must appear
  for (const cat of EXPECTED_CATEGORIES) {
    await expect(
      page.getByTestId(`marketplace-category-${cat}`),
      `Category '${cat}' must be visible`,
    ).toBeVisible({ timeout: 10_000 });
  }
});

// ── Test 2: Shopify tile is present and has connect input ────────────────────

test('shopify tile renders in storefront category with connect input', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-shopify');
  await page.goto('/settings/connectors');

  // Shopify tile in storefront category
  const shopifyTile = page.getByTestId('connector-tile-shopify');
  await expect(shopifyTile).toBeVisible({ timeout: 10_000 });

  // Shop domain input must be present (Shopify oauth requires it)
  await expect(page.getByTestId('input-shop-shopify')).toBeVisible();

  // Connect button must be present
  const connectBtn = page.getByTestId('connector-tile-shopify-connect');
  await expect(connectBtn).toBeVisible();

  // Connect button is disabled until a domain is entered
  await expect(connectBtn).toBeDisabled();

  // After entering a domain, button enables
  await page.getByTestId('input-shop-shopify').fill('my-store.myshopify.com');
  await expect(connectBtn).toBeEnabled();
});

// ── Test 3: A Coming-Soon tile is present and NOT connectable ────────────────

test('coming-soon tile is present and is structurally un-connectable', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-soon');
  await page.goto('/settings/connectors');

  await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 10_000 });

  // At least one Coming Soon badge must exist
  const comingSoonBadges = page.getByTestId('connector-tile-coming-soon');
  await expect(comingSoonBadges.first()).toBeVisible({ timeout: 10_000 });
  const count = await comingSoonBadges.count();
  expect(count, 'At least one coming-soon tile must exist').toBeGreaterThan(0);

  // WooCommerce is a known coming-soon connector — its connect button must be disabled.
  // (Meta/Google are NO LONGER coming-soon: feat-ad-connectors Track 1 flipped them to
  //  available oauth, so the stale meta-as-coming-soon assertion was corrected — see the
  //  separate test below that asserts meta is now connectable.)
  const wooTile = page.getByTestId('connector-tile-woocommerce');
  await expect(wooTile).toBeVisible({ timeout: 10_000 });

  const wooConnectBtn = page.getByTestId('connector-tile-woocommerce-connect');
  await expect(wooConnectBtn).toBeVisible();

  // Must be disabled (aria-disabled="true" and disabled attribute)
  await expect(wooConnectBtn).toBeDisabled();
  const ariaDisabled = await wooConnectBtn.getAttribute('aria-disabled');
  expect(ariaDisabled, 'Coming-soon tile must have aria-disabled="true"').toBe('true');

  // Clicking a disabled button must not fire any network request
  const postPromise = page.waitForRequest(
    (req) => req.url().includes('/api/bff/v1/connectors') && req.method() === 'POST',
    { timeout: 2_000 },
  ).catch(() => null);

  // Attempt to click — Playwright should either fail the click (disabled) or it is a no-op
  await wooConnectBtn.click({ force: true }); // force: ignore disabled for the click attempt
  const firedRequest = await postPromise;
  expect(firedRequest, 'No POST /connectors must fire for a coming-soon tile').toBeNull();
});

// ── Test 3b: Meta / Google ad tiles are now connectable (Track 1 registry flip) ──

test('meta and google ad tiles are connectable oauth tiles (no coming-soon badge)', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-ads');
  await page.goto('/settings/connectors');

  await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 10_000 });

  for (const id of ['meta', 'google_ads'] as const) {
    const tile = page.getByTestId(`connector-tile-${id}`);
    await expect(tile, `${id} tile must render`).toBeVisible({ timeout: 10_000 });

    // The Connect button must be ENABLED (available oauth — no shop-domain gate for ads).
    const connectBtn = page.getByTestId(`connector-tile-${id}-connect`);
    await expect(connectBtn).toBeVisible();
    await expect(connectBtn, `${id} connect must be enabled`).toBeEnabled();

    // No coming-soon badge inside this tile.
    await expect(
      tile.getByTestId('connector-tile-coming-soon'),
      `${id} must not show a coming-soon badge`,
    ).toHaveCount(0);
  }
});

// ── Test 4: Zero-connection brand renders complete marketplace (Skip-For-Now path) ─

test('marketplace renders fully for a freshly onboarded brand with zero connections', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-zero');
  await page.goto('/settings/connectors');

  // Page must load without error (no gate on zero connectors)
  await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 10_000 });

  // Shopify tile must render (not connected state)
  await expect(page.getByTestId('connector-tile-shopify')).toBeVisible({ timeout: 10_000 });

  // No health badge present (not connected yet)
  const healthBadge = page.getByTestId('connector-health-badge-shopify');
  await expect(healthBadge).toHaveCount(0);

  // Skip For Now link is present and navigates to dashboard
  const skipLink = page.getByTestId('btn-skip-for-now');
  await expect(skipLink).toBeVisible();
  await skipLink.click();
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
});

// ── Test 5: OAuth tile Connect initiates the POST /connectors call ───────────

test('OAuth tile Connect button fires POST /api/bff/v1/connectors with type=shopify', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-oauth');
  await page.goto('/settings/connectors');

  await expect(page.getByTestId('marketplace-page')).toBeVisible({ timeout: 10_000 });

  // Set up request interceptor BEFORE clicking connect
  const connectRequestPromise = page.waitForRequest(
    (req) =>
      req.url().includes('/api/bff/v1/connectors') &&
      req.method() === 'POST',
    { timeout: 15_000 },
  );

  // Enter shop domain and click connect
  await page.getByTestId('input-shop-shopify').fill('e2e-test.myshopify.com');
  await page.getByTestId('connector-tile-shopify-connect').click();

  // Assert the POST /connectors fired (intercept before redirect to Shopify)
  const connectRequest = await connectRequestPromise;
  expect(connectRequest.method(), 'Must be a POST').toBe('POST');
  expect(
    connectRequest.url(),
    'Must call the BFF /v1/connectors endpoint',
  ).toContain('/v1/connectors');

  // Assert request body contains type=shopify and shop_domain
  const postBody = connectRequest.postDataJSON() as {
    type?: string;
    shop_domain?: string;
  } | null;
  expect(postBody?.type, 'type must be shopify').toBe('shopify');
  expect(postBody?.shop_domain, 'shop_domain must be included').toBe('e2e-test.myshopify.com');

  // The response will be an OAuth redirect URL or an error (backend may return 422 in dev
  // if shop domain is invalid — we only assert the POST fired, not the final outcome).
});

// ── Test 6: Marketplace page BFF envelope shape ──────────────────────────────

test('GET /api/bff/v1/connectors returns correct envelope with tiles', async ({ page }) => {
  await onboardToDashboard(page, 'mkt-envelope');

  // Intercept the marketplace GET
  const responsePromise = page.waitForResponse(
    (res) =>
      res.url().includes('/api/bff/v1/connectors') &&
      res.request().method() === 'GET' &&
      !res.url().includes('/status') &&
      !res.url().includes('/install'),
    { timeout: 15_000 },
  );

  await page.goto('/settings/connectors');

  const response = await responsePromise;
  expect(response.status(), 'Marketplace GET must return 200').toBe(200);

  const body = await response.json() as {
    request_id?: string;
    data?: { tiles?: unknown[] };
  };

  // D-10 envelope: { request_id, data: { tiles } }
  expect(body, 'Response must have request_id').toHaveProperty('request_id');
  expect(body, 'Response must have .data').toHaveProperty('data');
  expect(body.data, '.data must have tiles array').toHaveProperty('tiles');
  expect(Array.isArray(body.data?.tiles), '.data.tiles must be an array').toBe(true);

  // NN-2: no secret_ref or token in any tile
  for (const tile of body.data?.tiles ?? []) {
    const t = tile as Record<string, unknown>;
    expect(t, 'Tile must not contain secret_ref (NN-2)').not.toHaveProperty('secret_ref');
    expect(t, 'Tile must not contain *_token (NN-2)').not.toHaveProperty('access_token');
    expect(t, 'Tile must not contain *_key (NN-2)').not.toHaveProperty('api_key');
    // Check nested instance if present
    if (t['instance'] && typeof t['instance'] === 'object') {
      const inst = t['instance'] as Record<string, unknown>;
      expect(inst, 'Instance must not contain secret_ref (NN-2)').not.toHaveProperty('secret_ref');
      expect(inst, 'Instance must not contain *_token (NN-2)').not.toHaveProperty('access_token');
    }
  }

  // All 7 categories must be present
  const tiles = body.data?.tiles ?? [];
  const categories = new Set((tiles as Array<{ category?: string }>).map((t) => t.category));
  for (const cat of EXPECTED_CATEGORIES) {
    expect(categories.has(cat), `Category '${cat}' must appear in tiles`).toBe(true);
  }
});
