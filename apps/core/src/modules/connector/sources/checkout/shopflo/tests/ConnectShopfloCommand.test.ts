/**
 * ConnectShopfloCommand.test.ts — Track B unit test.
 *
 * Proves:
 *   - Composite bundle { api_token, webhook_secret } stored under ONE secret_ref — derived from the
 *     declarative catalog (merchant_id is routing-only, resolved from the column, NOT in the bundle).
 *   - provider='shopflo'; only the ARN (secret_ref) is persisted on connector_instance (NN-2).
 *   - shopflo_merchant_id set under brand GUC (set_config call observed).
 *   - The connector.connected audit/event payload contains NO credential values (I-S09).
 */

import { describe, it, expect, vi } from 'vitest';
import { ConnectShopfloCommand } from '../application/commands/ConnectShopfloCommand.js';

function makeDeps() {
  const storeSecret = vi.fn(
    async (
      _brandId: string,
      _ref: { connectorType: string; subKey?: string },
      _bundle: Record<string, string>,
    ) => ({ arn: 'arn:test:shopflo:a', name: 'brain/connector/shopflo/a' }),
  );
  const secretsManager = { storeSecret } as never;

  const savedInstances: Array<Record<string, unknown>> = [];
  const connectorRepo = { save: vi.fn(async (i: Record<string, unknown>) => { savedInstances.push(i); }) } as never;
  const syncStatusRepo = { save: vi.fn(async () => undefined) } as never;

  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => { queries.push(sql); return { rows: [] }; }),
    release: vi.fn(),
  };
  const rawPgPool = { connect: vi.fn(async () => client) } as never;

  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const emitEvent = vi.fn(async (name: string, payload: Record<string, unknown>) => {
    emitted.push({ name, payload });
  });

  return { secretsManager, connectorRepo, syncStatusRepo, rawPgPool, emitEvent, storeSecret, savedInstances, queries, emitted };
}

describe('ConnectShopfloCommand', () => {
  it('stores composite bundle under one secret_ref and persists only the ARN (NN-2/I-S09)', async () => {
    const d = makeDeps();
    const cmd = new ConnectShopfloCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);

    const result = await cmd.execute({
      brandId: '11111111-1111-4111-8111-111111111111',
      apiToken: 'tok_secret_value',
      merchantId: 'mrc_001',
      webhookSecret: 'whsec_secret_value',
      idempotencyKey: 'idem-1',
    });

    expect(result.status).toBe('connected');

    // ONE storeSecret call with the catalog-derived bundle, keyed by merchant_id (non-secret subKey).
    // merchant_id is routing-only — the webhook handler resolves it from the column, never the bundle.
    expect(d.storeSecret).toHaveBeenCalledTimes(1);
    const [, ref, bundle] = d.storeSecret.mock.calls[0]!;
    expect(ref).toEqual({ connectorType: 'shopflo', subKey: 'mrc_001' });
    expect(bundle).toEqual({ api_token: 'tok_secret_value', webhook_secret: 'whsec_secret_value' });
    expect(bundle).not.toHaveProperty('merchant_id');

    // Persisted instance carries the ARN, never the raw credential values.
    const instance = d.savedInstances[0]! as { secretRef: string; provider: string };
    expect(instance.provider).toBe('shopflo');
    expect(instance.secretRef).toBe('arn:test:shopflo:a');
    expect(JSON.stringify(instance)).not.toContain('tok_secret_value');
    expect(JSON.stringify(instance)).not.toContain('whsec_secret_value');
  });

  it('sets shopflo_merchant_id under brand GUC', async () => {
    const d = makeDeps();
    const cmd = new ConnectShopfloCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    await cmd.execute({
      brandId: '11111111-1111-4111-8111-111111111111',
      apiToken: 'tok', merchantId: 'mrc_001', webhookSecret: 'wh', idempotencyKey: 'idem-2',
    });

    const joined = d.queries.join('\n');
    expect(joined).toContain("set_config('app.current_brand_id'");
    expect(joined).toContain('UPDATE connector_instance');
    expect(joined).toContain('shopflo_merchant_id');
  });

  it('connector.connected event payload contains NO credential values (I-S09)', async () => {
    const d = makeDeps();
    const cmd = new ConnectShopfloCommand(d.secretsManager, d.connectorRepo, d.syncStatusRepo, d.rawPgPool, d.emitEvent);
    await cmd.execute({
      brandId: '11111111-1111-4111-8111-111111111111',
      apiToken: 'tok_LEAK', merchantId: 'mrc_001', webhookSecret: 'wh_LEAK', idempotencyKey: 'idem-3',
    });

    const evt = d.emitted.find((e) => e.name === 'connector.connected');
    expect(evt).toBeDefined();
    const serialized = JSON.stringify(evt!.payload);
    expect(serialized).not.toContain('tok_LEAK');
    expect(serialized).not.toContain('wh_LEAK');
    expect(evt!.payload['provider']).toBe('shopflo');
  });
});
