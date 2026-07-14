/**
 * RegisterWebhooksCommand.test.ts — Slice A (CRIT-3 + idempotency + slash-form topics).
 *
 * Proves:
 *   1. Dev (APP_ENV != production) → stubbed no-op (no Shopify calls).
 *   2. Prod, fresh shop → registers the FULL topic set (5 order + 3 GDPR-compliance + app/uninstalled)
 *      in canonical SLASH form, addressed at the underscore path segment.
 *   3. Idempotent — existing subscriptions at our callback host are skipped (GET first), not re-POSTed.
 *   4. Idempotent — a Shopify 422 "address already been taken" is treated as success, never throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RegisterWebhooksCommand } from '../application/commands/RegisterWebhooksCommand.js';

const SECRET_REF = 'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/shopify/test';
const SHOP = 'boddactive-com.myshopify.com';
const CALLBACK_BASE = 'https://api.brain.ai';
const CALLBACK_URL = `${CALLBACK_BASE}/api/v1/webhooks/shopify`;

const EXPECTED_TOPICS = [
  'orders/create',
  'orders/updated',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
  'customers/data_request',
  'customers/redact',
  'shop/redact',
  'app/uninstalled',
  // P1 webhook expansion — real-time resource peers of the scheduled resource backfills
  // (RegisterWebhooksCommand ALL_WEBHOOK_TOPICS). Kept in lock-step with the command's list.
  'products/create',
  'products/update',
  'customers/create',
  'customers/update',
  'refunds/create',
  'fulfillments/create',
  'fulfillments/update',
  'inventory_levels/update',
];

function makeSecrets() {
  return {
    getShopifyToken: vi.fn().mockResolvedValue('shpat_token'),
    getSecret: vi.fn(),
    getShopifyClientSecret: vi.fn(),
    storeSecret: vi.fn(),
    deleteSecret: vi.fn(),
    storeShopifyToken: vi.fn(),
    deleteShopifyToken: vi.fn(),
    putSecretValue: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

let originalFetch: typeof global.fetch;
beforeEach(() => { originalFetch = global.fetch; });
afterEach(() => { global.fetch = originalFetch; });

describe('RegisterWebhooksCommand', () => {
  it('dev: stubbed no-op, makes no Shopify calls', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof global.fetch;
    const cmd = new RegisterWebhooksCommand(makeSecrets(), 'development');

    const result = await cmd.execute({ shopDomain: SHOP, secretRef: SECRET_REF, callbackBaseUrl: CALLBACK_BASE });

    expect(result).toEqual({ registered: false, topicCount: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prod fresh shop: registers full slash-form topic set incl. compliance topics', async () => {
    const posted: Array<{ topic: string; address: string }> = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === 'GET') return jsonResponse(200, { webhooks: [] });
      const parsed = JSON.parse(init.body as string) as { webhook: { topic: string; address: string } };
      posted.push({ topic: parsed.webhook.topic, address: parsed.webhook.address });
      return jsonResponse(201, { webhook: { id: 1 } });
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const cmd = new RegisterWebhooksCommand(makeSecrets(), 'production');
    const result = await cmd.execute({ shopDomain: SHOP, secretRef: SECRET_REF, callbackBaseUrl: CALLBACK_BASE });

    expect(result.registered).toBe(true);
    expect(result.topicCount).toBe(EXPECTED_TOPICS.length);
    expect(posted.map((p) => p.topic).sort()).toEqual([...EXPECTED_TOPICS].sort());
    // Slash-form topic in the body, underscore-encoded single path segment in the address.
    const create = posted.find((p) => p.topic === 'orders/create')!;
    expect(create.address).toBe(`${CALLBACK_URL}/orders_create`);
    const dataReq = posted.find((p) => p.topic === 'customers/data_request')!;
    expect(dataReq.address).toBe(`${CALLBACK_URL}/customers_data_request`);
    // Mandatory compliance topics are present.
    for (const t of ['customers/redact', 'customers/data_request', 'shop/redact', 'app/uninstalled']) {
      expect(posted.some((p) => p.topic === t)).toBe(true);
    }
  });

  it('idempotent: existing subscriptions at our callback host are skipped (counted, not re-POSTed)', async () => {
    let posts = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === 'GET') {
        return jsonResponse(200, {
          webhooks: [
            { topic: 'orders/create', address: `${CALLBACK_URL}/orders_create` },
            { topic: 'app/uninstalled', address: `${CALLBACK_URL}/app_uninstalled` },
            // A subscription to a DIFFERENT host must NOT count as ours → still re-created.
            { topic: 'orders/paid', address: 'https://evil.example.com/api/v1/webhooks/shopify/orders_paid' },
          ],
        });
      }
      posts += 1;
      return jsonResponse(201, { webhook: { id: posts } });
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const cmd = new RegisterWebhooksCommand(makeSecrets(), 'production');
    const result = await cmd.execute({ shopDomain: SHOP, secretRef: SECRET_REF, callbackBaseUrl: CALLBACK_BASE });

    expect(result.topicCount).toBe(EXPECTED_TOPICS.length); // all topics accounted for
    // 2 already at our host (orders/create, app/uninstalled) skipped → the rest are POSTed (incl. the
    // foreign-host orders/paid, which does NOT count as ours).
    expect(posts).toBe(EXPECTED_TOPICS.length - 2);
  });

  it('idempotent: Shopify 422 "address already been taken" is treated as success (no throw)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === 'GET') return jsonResponse(200, { webhooks: [] });
      return jsonResponse(422, { errors: { address: ['for this topic has already been taken'] } });
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const cmd = new RegisterWebhooksCommand(makeSecrets(), 'production');
    const result = await cmd.execute({ shopDomain: SHOP, secretRef: SECRET_REF, callbackBaseUrl: CALLBACK_BASE });

    expect(result.registered).toBe(true);
    expect(result.topicCount).toBe(EXPECTED_TOPICS.length);
  });

  it('prod: a non-taken 422 still throws (real failure surfaces)', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init || init.method === 'GET') return jsonResponse(200, { webhooks: [] });
      return jsonResponse(422, { errors: { topic: ['is invalid'] } });
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    const cmd = new RegisterWebhooksCommand(makeSecrets(), 'production');
    await expect(
      cmd.execute({ shopDomain: SHOP, secretRef: SECRET_REF, callbackBaseUrl: CALLBACK_BASE }),
    ).rejects.toThrow(/status=422/);
  });
});
