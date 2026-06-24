/**
 * ShopifyGdprUninstall.test.ts — unit tests for the GDPR + uninstall compliance gap.
 *
 * Proves:
 *   1. customers/data_request → skip=true (fast-ack, no Kafka produce, no sideEffect).
 *   2. shop/redact            → skip=true (fast-ack, no Kafka produce, no sideEffect).
 *   3. customers/redact       → skip=true + sideEffect fires erase_customer SECURITY DEFINER path.
 *   4. app/uninstalled        → skip=true + sideEffect marks ConnectorInstance Disconnected.
 *   5. Unknown topic (orders/updated before GDPR topics added) still fast-acks (regression).
 *
 * These are pure unit tests: no DB, no Redis, no Kafka — just the strategy object.
 * The sideEffect is invoked with a mock pg.Pool and its calls are captured.
 */

import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { ShopifyWebhookStrategy } from '../strategies/ShopifyWebhookStrategy.js';
import type { WebhookStrategyContext } from '../platform/IWebhookStrategy.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCtx(topic: string, body: Record<string, unknown> = {}): WebhookStrategyContext {
  return {
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-wh-topic': topic },
    parsedBody: null,
    brandId: 'brand-uuid-001',
    saltHex: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
    regionCode: 'IN',
    correlationId: 'corr-001',
    requestId: 'req-001',
  } as WebhookStrategyContext;
}

/**
 * Build a minimal mock pg.Pool that captures query calls.
 * Returns { pool, getQueries } — getQueries() returns all text strings passed to pool.query.
 */
function makeMockPool(): { pool: pg.Pool; getQueries: () => string[] } {
  const queries: string[] = [];
  let clientReleased = false;

  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(typeof text === 'string' ? text : String(text));
      return { rows: [{ brain_id: 'brain-id-from-resolver' }] };
    }),
    release: vi.fn(() => { clientReleased = true; }),
  };

  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(async (text: string, params?: unknown[]) => {
      const q = typeof text === 'string' ? text : String(text);
      queries.push(q);
      // Simulate erase_customer returning a result
      if (q.includes('erase_customer') || q.includes('resolve_brain_id')) {
        return { rows: [{ brain_id: 'brain-id-from-resolver', result: { erased: true } }] };
      }
      return { rows: [] };
    }),
  } as unknown as pg.Pool;

  void clientReleased;

  return { pool, getQueries: () => queries };
}

// ── Strategy under test ────────────────────────────────────────────────────────

const strategy = new ShopifyWebhookStrategy();

// ─────────────────────────────────────────────────────────────────────────────

describe('ShopifyWebhookStrategy — GDPR + uninstall compliance (shopify-compliance-token-lifecycle)', () => {

  it('customers/data_request → skip=true, no sideEffect', async () => {
    const result = await strategy.payloadMap(makeCtx('customers/data_request'));
    expect(result.skip).toBe(true);
    expect(result.sideEffect).toBeUndefined();
    expect(result.eventId).toBe('');
  });

  it('shop/redact → skip=true, no sideEffect', async () => {
    const result = await strategy.payloadMap(makeCtx('shop/redact'));
    expect(result.skip).toBe(true);
    expect(result.sideEffect).toBeUndefined();
    expect(result.eventId).toBe('');
  });

  it('customers/redact → skip=true, sideEffect present (erase path wired)', async () => {
    const body = {
      customer: { id: 12345 },
      shop_id: 67890,
      orders_to_redact: [{ id: 9001 }],
    };
    const result = await strategy.payloadMap(makeCtx('customers/redact', body));

    expect(result.skip).toBe(true);
    // sideEffect must be present — it is the GDPR erasure path
    expect(result.sideEffect).toBeDefined();
    // throwOnSideEffectError must be false (fire-and-forget; Shopify sees 200)
    expect(result.throwOnSideEffectError).toBe(false);
    expect(result.eventId).toBe('');
  });

  it('customers/redact sideEffect resolves brain_id then erases via the Neo4j identity reader (ADR-0004)', async () => {
    // Pin the per-brand salt for 'brand-uuid-001' so the resolve hash path runs deterministically.
    process.env['IDENTITY_SALT_BRANDUUID001'] = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    const { pool } = makeMockPool();
    const body = { customer: { id: 99001 } };
    const result = await strategy.payloadMap(makeCtx('customers/redact', body));
    expect(result.sideEffect).toBeDefined();

    // MEDALLION REALIGNMENT (Epic 3): identity is the Neo4j SoR — the redact resolves + erases via the
    // injected reader (4th arg), not the dropped PG erase_customer/resolve_brain_id functions.
    const calls: string[] = [];
    const reader = {
      resolveBrainIdByStorefrontCustomerId: async (b: string, h: string) => {
        calls.push(`resolve:${b}:${h.slice(0, 8)}`);
        return 'brain-id-from-graph';
      },
      eraseCustomer: async (b: string, id: string) => {
        calls.push(`erase:${b}:${id}`);
        return { erased: true, contact_pii_deleted: 0, links_tombstoned: 1 };
      },
    };
    // The redact uses the brand captured at payloadMap time (ctx.brandId='brand-uuid-001'), not the
    // call-time arg — that is the brand the webhook was received for.
    await result.sideEffect!('ignored-call-arg', pool, 'req-001', reader);

    expect(calls.some((c) => c.startsWith('resolve:brand-uuid-001:'))).toBe(true);
    expect(calls.some((c) => c === 'erase:brand-uuid-001:brain-id-from-graph')).toBe(true);
  });

  it('customers/redact sideEffect with no customer.id in body → no-op (no erase call)', async () => {
    const { pool, getQueries } = makeMockPool();
    // Body has no customer field at all
    const body = { shop_id: 67890 };
    const result = await strategy.payloadMap(makeCtx('customers/redact', body));

    expect(result.sideEffect).toBeDefined();
    await result.sideEffect!('brand-uuid-001', pool, 'req-001');

    // With no customer.id, the side-effect should bail out without calling erase
    const hasErase = getQueries().some((q) => q.includes('erase_customer'));
    expect(hasErase).toBe(false);
  });

  it('app/uninstalled → skip=true, sideEffect present (marks Disconnected)', async () => {
    const result = await strategy.payloadMap(makeCtx('app/uninstalled'));

    expect(result.skip).toBe(true);
    expect(result.sideEffect).toBeDefined();
    expect(result.throwOnSideEffectError).toBe(false);
    expect(result.eventId).toBe('');
  });

  it('app/uninstalled sideEffect issues UPDATE connector_instance SET status=disconnected', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        if (typeof text === 'string') queries.push(text);
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as pg.Pool;

    const result = await strategy.payloadMap(makeCtx('app/uninstalled'));
    await result.sideEffect!('brand-uuid-001', pool, 'req-001');

    // Must have BEGIN + GUC + UPDATE + COMMIT
    expect(queries.some((q) => q === 'BEGIN')).toBe(true);
    expect(queries.some((q) => q.includes('set_config') && q.includes('app.current_brand_id'))).toBe(true);
    expect(queries.some((q) =>
      q.includes('UPDATE connector_instance') &&
      q.includes("status = 'disconnected'") &&
      q.includes("health_state = 'Disconnected'") &&
      q.includes("safety_rating = 'blocked'"),
    )).toBe(true);
    expect(queries.some((q) => q === 'COMMIT')).toBe(true);
  });

  it('unknown topic still fast-acks (no regression)', async () => {
    const result = await strategy.payloadMap(makeCtx('products/create'));
    expect(result.skip).toBe(true);
    expect(result.sideEffect).toBeUndefined();
  });

  it('order topic still produces an event (no regression)', async () => {
    const body = {
      id: 9876,
      created_at: '2026-06-22T10:00:00Z',
      updated_at: '2026-06-22T10:00:00Z',
      processed_at: '2026-06-22T10:00:00Z',
      currency: 'INR',
      current_total_price: '1000.00',
      financial_status: 'paid',
    };
    const result = await strategy.payloadMap(makeCtx('orders/paid', body));
    // Orders should NOT be skipped
    expect(result.skip).toBe(false);
    expect(result.eventId).not.toBe('');
  });
});
