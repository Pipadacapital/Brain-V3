/**
 * connector-lifecycle-fixtures.ts — FROZEN shared fixtures for the connector-lifecycle
 * regression suite (chore-connector-lifecycle-regression / A0 slice).
 *
 * FROZEN — do not change after A0 commit without architect sign-off.
 *
 * Exports:
 *   - UUID constants (test brand IDs, CI ID, NIL_UUID)
 *   - buildFakeStore / buildShopifyFetchStub  (A1 pagination walk)
 *   - seedTestBrand / seedConnectorInstance / seedSyncStatus / cleanupConnectorFixtures
 *   - assertBrainApp  (D-3 isolation guard — call at the top of every isolation assertion)
 *
 * DATA-SAFETY: NEVER references 60d543dc-* (D-5).
 * ISOLATION: all seed/cleanup via superuser Pool; all isolation assertions via appPool (brain_app).
 */

import type { Pool } from 'pg';
import { expect } from 'vitest';

// ── UUID constants ─────────────────────────────────────────────────────────────

/** Test brand A — recognisable c0nec701 prefix, valid UUIDv4, NEVER a live brand. */
export const CONNECTOR_TEST_BRAND_A = 'c0nec701-0a00-4a00-8a00-000000000001';

/** Test brand B — for cross-brand isolation negative control. */
export const CONNECTOR_TEST_BRAND_B = 'c0nec702-0b00-4b00-8b00-000000000002';

/** Test connector_instance_id — CI prefix. */
export const CONNECTOR_TEST_CI_ID = 'c0nec7c1-0c00-4c00-8c00-000000000003';

/** NIL UUID — the sentinel used by run.ts:270 for the worker GUC fix (D-6). */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ── Fake Shopify order shape ───────────────────────────────────────────────────

export interface FakeShopifyOrder {
  id: number;
  name: string;
  created_at: string;
  processed_at: string;
  cancelled_at: null;
  currency: string;
  current_total_price: string;
  financial_status: string;
  fulfillment_status: null;
  gateway: string;
  payment_gateway_names: string[];
  tags: null;
  customer: null;
}

/**
 * Build an in-memory fake Shopify store of `total` orders.
 * Orders have sequential IDs 1..total, ascending (mirrors Shopify since_id ordering).
 */
export function buildFakeStore(total = 600): FakeShopifyOrder[] {
  const orders: FakeShopifyOrder[] = [];
  for (let i = 1; i <= total; i++) {
    orders.push({
      id: i,
      name: `#${String(i).padStart(5, '0')}`,
      created_at: '2024-01-15T10:00:00Z',
      processed_at: '2024-01-15T10:00:00Z',
      cancelled_at: null,
      currency: 'INR',
      current_total_price: '1000.00',
      financial_status: 'paid',
      fulfillment_status: null,
      gateway: 'razorpay',
      payment_gateway_names: ['razorpay'],
      tags: null,
      customer: null,
    });
  }
  return orders;
}

/**
 * Build a stubbed `fetch` implementation backed by the fake store.
 *
 * The stub pages the store by parsing `since_id` and `limit` from the request URL.
 * Every request URL is pushed onto `recordedRequests` so tests can assert the
 * FIRST fetch call carried `since_id=0` (the non-inert revert-RED for D-4 / A1).
 *
 * Returns:
 *   fetchImpl  — the fetch stub (pass to vi.stubGlobal('fetch', fetchImpl))
 *   recordedRequests — mutable array of all request URLs, in call order
 */
export function buildShopifyFetchStub(store: FakeShopifyOrder[]): {
  fetchImpl: typeof fetch;
  recordedRequests: string[];
} {
  const recordedRequests: string[] = [];

  const fetchImpl = async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const urlStr = typeof input === 'string' ? input : input.toString();
    recordedRequests.push(urlStr);

    // Parse since_id and limit from URL query parameters
    const urlObj = new URL(urlStr);
    const sinceIdParam = urlObj.searchParams.get('since_id') ?? '0';
    const limitParam = urlObj.searchParams.get('limit');
    const pageSize = limitParam ? parseInt(limitParam, 10) : 250;

    // Handle count endpoint (countOrders call)
    if (urlStr.includes('/orders/count.json')) {
      const body = JSON.stringify({ count: store.length });
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Handle orders page endpoint
    const sinceIdNum = parseInt(sinceIdParam, 10) || 0;

    // Filter: orders with id > sinceId (Shopify since_id semantics)
    const eligible = store.filter((o) => o.id > sinceIdNum);
    const page = eligible.slice(0, pageSize);

    const body = JSON.stringify({ orders: page });
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return { fetchImpl: fetchImpl as typeof fetch, recordedRequests };
}

// ── DB seed helpers (superuser pool only) ─────────────────────────────────────

/**
 * Seed a test brand into the brand table.
 * Uses ON CONFLICT DO NOTHING — safe to call in beforeAll on repeated runs.
 */
export async function seedTestBrand(
  superPool: Pool,
  brandId: string,
  currency = 'INR',
): Promise<void> {
  // Re-use an existing organization_id to satisfy FK (mirrors backfill.e2e:253-264)
  const orgResult = await superPool.query<{ id: string }>('SELECT id FROM organization LIMIT 1');
  const orgId = orgResult.rows[0]?.id;
  if (!orgId) throw new Error('[fixture] No organization row found — run seed migrations first');

  await superPool.query(
    `INSERT INTO brand (id, organization_id, display_name, currency_code, region_code)
     VALUES ($1, $2, $3, $4, 'IN')
     ON CONFLICT (id) DO NOTHING`,
    [brandId, orgId, `Test Brand (lifecycle ${brandId.slice(0, 8)})`, currency],
  );
}

/**
 * Seed a connector_instance row.
 * status defaults to 'connected'; pass status='disconnected' for disconnect-tile tests.
 */
export async function seedConnectorInstance(
  superPool: Pool,
  opts: {
    brandId: string;
    ciId: string;
    status?: string;
    secretRef?: string;
    shopDomain?: string;
  },
): Promise<void> {
  const {
    brandId,
    ciId,
    status = 'connected',
    secretRef = `arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/${brandId}/test-myshopify-com`,
    shopDomain = 'test.myshopify.com',
  } = opts;

  await superPool.query(
    `INSERT INTO connector_instance
       (id, brand_id, provider, status, shop_domain, secret_ref)
     VALUES ($1, $2, 'shopify', $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           shop_domain = EXCLUDED.shop_domain,
           secret_ref = EXCLUDED.secret_ref`,
    [ciId, brandId, status, shopDomain, secretRef],
  );
}

/**
 * Seed a connector_sync_status row.
 * state defaults to 'waiting_for_data'.
 */
export async function seedSyncStatus(
  superPool: Pool,
  opts: {
    brandId: string;
    ciId: string;
    state?: string;
  },
): Promise<void> {
  const { brandId, ciId, state = 'waiting_for_data' } = opts;

  await superPool.query(
    `INSERT INTO connector_sync_status
       (brand_id, connector_instance_id, state)
     VALUES ($1, $2, $3)
     ON CONFLICT (brand_id, connector_instance_id) DO UPDATE
       SET state = EXCLUDED.state, updated_at = NOW()`,
    [brandId, ciId, state],
  );
}

/**
 * Clean up ALL rows seeded by the connector-lifecycle test suite for the given brand IDs.
 * Deletes in dependency order to satisfy FK constraints.
 * NEVER touches 60d543dc-* (D-5 — the guard is the brandIds list itself).
 */
export async function cleanupConnectorFixtures(
  superPool: Pool,
  brandIds: string[],
): Promise<void> {
  if (brandIds.length === 0) return;

  // Build $1,$2,... placeholders
  const placeholders = brandIds.map((_, i) => `$${i + 1}`).join(', ');

  await superPool
    .query(`DELETE FROM connector_sync_status WHERE brand_id IN (${placeholders})`, brandIds)
    .catch(() => undefined);

  await superPool
    .query(`DELETE FROM connector_cursor WHERE brand_id IN (${placeholders})`, brandIds)
    .catch(() => undefined);

  await superPool
    .query(`DELETE FROM connector_instance WHERE brand_id IN (${placeholders})`, brandIds)
    .catch(() => undefined);

  // dev_secret: name LIKE 'brain/connector/shopify/<brandId>%' — avoids touching live secrets
  for (const brandId of brandIds) {
    await superPool
      .query(`DELETE FROM dev_secret WHERE name LIKE $1`, [`brain/connector/shopify/${brandId}%`])
      .catch(() => undefined);
  }

  await superPool
    .query(`DELETE FROM realized_revenue_ledger WHERE brand_id IN (${placeholders})`, brandIds)
    .catch(() => undefined);

  await superPool
    .query(`DELETE FROM brand WHERE id IN (${placeholders})`, brandIds)
    .catch(() => undefined);
}

// ── brain_app discipline guard (D-3 durable rule) ────────────────────────────

/**
 * Assert that `appPool` is connected as brain_app (non-superuser, NOBYPASSRLS).
 *
 * CALL THIS AT THE TOP OF EVERY ISOLATION ASSERTION.
 *
 * This is the Single-Primitive for the durable rule from system-job-force-rls-enumeration.
 * If this assertion fails, the isolation test below it is structurally inert (the dev
 * superuser 'brain' bypasses RLS — MEMORY: dev-db-superuser-masks-rls).
 *
 * Mirrors revenue-metrics.live.test.ts:306-315.
 */
export async function assertBrainApp(appPool: Pool): Promise<void> {
  const r = await appPool.query<{ current_user: string; is_superuser: boolean }>(
    `SELECT current_user,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`,
  );
  expect(r.rows[0]!.current_user).toBe('brain_app');
  expect(r.rows[0]!.is_superuser).toBe(false);
}
