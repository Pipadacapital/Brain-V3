/**
 * ConnectWooCommerceCommand.test.ts — unit tests (infra-free).
 *
 * Proves:
 *   - validate() returns valid=false on 401/403 (credential probe rejects correctly).
 *   - validate() returns valid=true on 200.
 *   - validate() returns valid=false + reason on network error.
 *   - execute() stores the composite bundle (consumer_key, consumer_secret, webhook_secret,
 *     site_url) under one secret_ref and persists only the ARN (NN-2/I-S09).
 *   - execute() sets woocommerce_site_url under brand GUC (set_config observable).
 *   - connector.connected event payload contains NO credential values (I-S09).
 *   - Webhook auto-registration: POST /wp-json/wc/v3/webhooks called for each topic that
 *     is not already registered (idempotent — skips if already present).
 *   - Webhook registration failure is non-fatal (connect still returns status='connected').
 *   - Trailing slash in siteUrl is normalised (stripped) before storage + webhook lookup.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConnectWooCommerceCommand } from '../application/commands/ConnectWooCommerceCommand.js';

// ── Shared test stub factory ───────────────────────────────────────────────────

function makeDeps() {
  const storeSecret = vi.fn(
    async (
      _brandId: string,
      _ref: { connectorType: string; subKey?: string },
      _bundle: Record<string, string>,
    ) => ({ arn: 'arn:test:woocommerce:site-a', name: 'brain/connector/woocommerce/site-a' }),
  );
  const secretsManager = { storeSecret } as never;

  const savedInstances: Array<Record<string, unknown>> = [];
  const connectorRepo = {
    save: vi.fn(async (i: Record<string, unknown>) => { savedInstances.push(i); }),
    // one-storefront-per-brand guard reads this; default = no existing storefront.
    findAllByBrand: vi.fn(async () => []),
  } as never;
  const syncStatusRepo = { save: vi.fn(async () => undefined) } as never;

  const queries: string[] = [];
  const queryParams: Array<unknown[]> = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push(sql);
      queryParams.push(params ?? []);
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const rawPgPool = { connect: vi.fn(async () => client) } as never;

  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const emitEvent = vi.fn(async (name: string, payload: Record<string, unknown>) => {
    emitted.push({ name, payload });
  });

  return { secretsManager, connectorRepo, syncStatusRepo, rawPgPool, emitEvent, storeSecret, savedInstances, queries, queryParams, emitted, client };
}

const BRAND_ID = '11111111-1111-4111-8111-111111111111';
const SITE_URL = 'https://store.example.com';
const CONSUMER_KEY = 'ck_abc123';
const CONSUMER_SECRET = 'cs_secret_value';

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── validate() ────────────────────────────────────────────────────────────────

describe('ConnectWooCommerceCommand.validate', () => {
  it('returns valid=true when system_status probe returns 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}),
    } as unknown as Response)));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.validate({ siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns valid=false with reason on 401 (bad consumer key/secret)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 401, json: async () => ({}),
    } as unknown as Response)));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.validate({ siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/401/);
  });

  it('returns valid=false with reason on 403 (forbidden)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({}),
    } as unknown as Response)));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.validate({ siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/403/);
  });

  it('returns valid=false with reason on network error (fetch throws)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.validate({ siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain('ECONNREFUSED');
  });

  it('returns valid=false when required fields are missing', async () => {
    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.validate({ siteUrl: '', consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET });

    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/required/);
  });
});

// ── execute() ─────────────────────────────────────────────────────────────────

describe('ConnectWooCommerceCommand.execute', () => {
  it('stores composite bundle under one secret_ref and persists only the ARN (NN-2/I-S09)', async () => {
    // Stub fetch: system_status probe succeeds; list webhooks returns []; register each returns ok.
    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      callCount++;
      if ((url as string).includes('system_status')) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if ((init.method ?? 'GET') === 'GET' && (url as string).includes('/webhooks')) {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      // POST webhook registration
      return { ok: true, status: 201, json: async () => ({ id: callCount, topic: 'order.created', delivery_url: 'https://api.brain.ai/api/v1/webhooks/woocommerce' }) } as unknown as Response;
    }));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.execute({
      brandId: BRAND_ID, siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, idempotencyKey: 'idem-1',
    });

    expect(result.status).toBe('connected');

    // ONE storeSecret call with the full bundle.
    expect(d.storeSecret).toHaveBeenCalledTimes(1);
    const [, ref, bundle] = d.storeSecret.mock.calls[0]!;
    expect(ref).toMatchObject({ connectorType: 'woocommerce' });
    expect(bundle).toMatchObject({ consumer_key: CONSUMER_KEY, consumer_secret: CONSUMER_SECRET, site_url: SITE_URL });
    expect(bundle).toHaveProperty('webhook_secret');

    // Persisted instance carries the ARN — never the raw credential values.
    const inst = d.savedInstances[0]! as { secretRef: string; provider: string };
    expect(inst.provider).toBe('woocommerce');
    expect(inst.secretRef).toBe('arn:test:woocommerce:site-a');
    expect(JSON.stringify(inst)).not.toContain(CONSUMER_SECRET);
  });

  it('sets woocommerce_site_url under brand GUC (set_config observable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] } as unknown as Response)));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    await cmd.execute({
      brandId: BRAND_ID, siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, idempotencyKey: 'idem-2',
    });

    const joined = d.queries.join('\n');
    expect(joined).toContain("set_config('app.current_brand_id'");
    expect(joined).toContain('UPDATE connector_instance');
    expect(joined).toContain('woocommerce_site_url');
  });

  it('connector.connected event payload contains NO credential values (I-S09)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] } as unknown as Response)));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    await cmd.execute({
      brandId: BRAND_ID, siteUrl: SITE_URL, consumerKey: 'ck_LEAK', consumerSecret: 'cs_LEAK', idempotencyKey: 'idem-3',
    });

    const evt = d.emitted.find((e) => e.name === 'connector.connected');
    expect(evt).toBeDefined();
    const serialized = JSON.stringify(evt!.payload);
    expect(serialized).not.toContain('ck_LEAK');
    expect(serialized).not.toContain('cs_LEAK');
    expect(evt!.payload['provider']).toBe('woocommerce');
  });

  it('normalises trailing slash in siteUrl before storage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => [] } as unknown as Response)));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    await cmd.execute({
      brandId: BRAND_ID, siteUrl: 'https://store.example.com///', consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, idempotencyKey: 'idem-4',
    });

    // The bundle stored should have the normalised URL (no trailing slash).
    const [, , bundle] = d.storeSecret.mock.calls[0]!;
    expect((bundle as Record<string, string>)['site_url']).toBe('https://store.example.com');
  });

  it('webhook auto-registration: POST called for each unregistered topic', async () => {
    const postCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if ((url as string).includes('system_status')) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (method === 'GET' && (url as string).includes('/webhooks')) {
        // No existing webhooks.
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      if (method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as { topic?: string };
        postCalls.push(body.topic ?? '');
        return { ok: true, status: 201, json: async () => ({ id: 1, topic: body.topic, delivery_url: '' }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.execute({
      brandId: BRAND_ID, siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, idempotencyKey: 'idem-5',
    });

    // Both order.created and order.updated should have been registered.
    expect(postCalls).toContain('order.created');
    expect(postCalls).toContain('order.updated');
    expect(result.webhooksRegistered).toHaveLength(2);
    expect(result.webhookRegistrationErrors).toHaveLength(0);
  });

  it('skips already-registered topics (idempotent webhook registration)', async () => {
    const postCalls: string[] = [];
    const DELIVERY_URL = 'https://api.brain.ai/api/v1/webhooks/woocommerce';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if ((url as string).includes('system_status')) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (method === 'GET' && (url as string).includes('/webhooks')) {
        // order.created already registered; order.updated is not.
        return {
          ok: true, status: 200,
          json: async () => [
            { id: 10, topic: 'order.created', delivery_url: DELIVERY_URL },
          ],
        } as unknown as Response;
      }
      if (method === 'POST') {
        const body = JSON.parse((init.body as string) ?? '{}') as { topic?: string };
        postCalls.push(body.topic ?? '');
        return { ok: true, status: 201, json: async () => ({ id: 2, topic: body.topic, delivery_url: DELIVERY_URL }) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    }));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.execute({
      brandId: BRAND_ID, siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, idempotencyKey: 'idem-6',
    });

    // Only order.updated should have triggered a POST (order.created was already there).
    expect(postCalls).not.toContain('order.created');
    expect(postCalls).toContain('order.updated');
    expect(result.webhooksRegistered).toHaveLength(2); // order.created (skipped) + order.updated (registered)
    expect(result.webhookRegistrationErrors).toHaveLength(0);
  });

  it('connect succeeds even when webhook auto-registration fails (non-fatal)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const method = init.method ?? 'GET';
      if ((url as string).includes('system_status')) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      if (method === 'GET') {
        return { ok: true, status: 200, json: async () => [] } as unknown as Response;
      }
      // POST fails.
      return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
    }));

    const d = makeDeps();
    const cmd = new ConnectWooCommerceCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    const result = await cmd.execute({
      brandId: BRAND_ID, siteUrl: SITE_URL, consumerKey: CONSUMER_KEY, consumerSecret: CONSUMER_SECRET, idempotencyKey: 'idem-7',
    });

    expect(result.status).toBe('connected');
    expect(result.webhookRegistrationErrors.length).toBeGreaterThan(0);
  });
});
