/**
 * ActivateAdAccountCommand tests — choose the ONE ingesting ad account (0106).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditWriter } from '@brain/audit';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import { ConnectorInstance } from '@brain/connector-core';
import { ActivateAdAccountCommand } from './ActivateAdAccountCommand.js';

const BRAND = '11111111-1111-4111-8111-111111111111';
const CI = '22222222-2222-4222-8222-222222222222';

function instance(overrides: Partial<Parameters<typeof ConnectorInstance.create>[0]> = {}): ConnectorInstance {
  const now = new Date('2026-06-24T00:00:00.000Z');
  return ConnectorInstance.create({
    id: CI,
    brandId: BRAND,
    provider: 'meta',
    shopDomain: '',
    secretRef: 'arn:dev:secret:meta',
    status: 'connected',
    healthState: 'Healthy',
    safetyRating: 'safe',
    connectedAt: now,
    disconnectedAt: null,
    createdAt: now,
    updatedAt: now,
    accountKey: 'act_123',
    activatedAt: null,
    ...overrides,
  });
}

function makeRepo(found: ConnectorInstance | null, activated: ConnectorInstance | null): IConnectorInstanceRepository {
  return {
    findByBrandAndProvider: vi.fn(),
    findById: vi.fn().mockResolvedValue(found),
    findAllByBrand: vi.fn(),
    findAllByBrandAndProvider: vi.fn(),
    save: vi.fn(),
    update: vi.fn(),
    activateAccount: vi.fn().mockResolvedValue(activated),
  } as unknown as IConnectorInstanceRepository;
}

function makeAudit(): AuditWriter {
  return { append: vi.fn().mockResolvedValue(undefined) } as unknown as AuditWriter;
}

describe('ActivateAdAccountCommand', () => {
  let audit: AuditWriter;
  beforeEach(() => {
    audit = makeAudit();
  });

  it('activates an ad account and audits the choice (switch happens in the repo)', async () => {
    const target = instance();
    const activated = instance({ activatedAt: new Date('2026-06-24T01:00:00.000Z') });
    const repo = makeRepo(target, activated);
    const cmd = new ActivateAdAccountCommand(repo, audit);

    const res = await cmd.execute({
      connectorInstanceId: CI, brandId: BRAND, correlationId: 'c', actorId: 'u', actorRole: 'manager',
    });

    expect(res.ok).toBe(true);
    expect(repo.activateAccount).toHaveBeenCalledWith(CI, BRAND);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'connector.ad_account.activated', brand_id: BRAND }),
    );
  });

  it('rejects a non-ad provider (storefront/payment ingest automatically)', async () => {
    const repo = makeRepo(instance({ provider: 'shopify' }), null);
    const cmd = new ActivateAdAccountCommand(repo, audit);
    const res = await cmd.execute({
      connectorInstanceId: CI, brandId: BRAND, correlationId: 'c', actorId: null, actorRole: 'manager',
    });
    expect(res).toMatchObject({ ok: false, code: 'NOT_AD_PLATFORM' });
    expect(repo.activateAccount).not.toHaveBeenCalled();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('404s when the connector is not found for this brand', async () => {
    const repo = makeRepo(null, null);
    const cmd = new ActivateAdAccountCommand(repo, audit);
    const res = await cmd.execute({
      connectorInstanceId: CI, brandId: BRAND, correlationId: 'c', actorId: null, actorRole: 'manager',
    });
    expect(res).toMatchObject({ ok: false, code: 'CONNECTOR_NOT_FOUND' });
  });

  it('rejects activating a disconnected ad account (reconnect first)', async () => {
    const repo = makeRepo(instance({ status: 'disconnected', healthState: 'Disconnected', safetyRating: 'blocked' }), null);
    const cmd = new ActivateAdAccountCommand(repo, audit);
    const res = await cmd.execute({
      connectorInstanceId: CI, brandId: BRAND, correlationId: 'c', actorId: null, actorRole: 'manager',
    });
    expect(res).toMatchObject({ ok: false, code: 'CONNECTOR_NOT_CONNECTED' });
    expect(repo.activateAccount).not.toHaveBeenCalled();
  });

  it('treats a lost switch race (repo returns null) as not-found, no audit', async () => {
    const repo = makeRepo(instance(), null); // found, but activateAccount → null
    const cmd = new ActivateAdAccountCommand(repo, audit);
    const res = await cmd.execute({
      connectorInstanceId: CI, brandId: BRAND, correlationId: 'c', actorId: null, actorRole: 'manager',
    });
    expect(res).toMatchObject({ ok: false, code: 'CONNECTOR_NOT_FOUND' });
    expect(audit.append).not.toHaveBeenCalled();
  });
});
