/**
 * DisconnectCommand unit tests.
 *
 * Shared-secret refcount (Gap B multi-account): Meta/Google connects create ONE instance per
 * ad account, all sharing a single Secrets Manager token secret (one secret_ref). Disconnecting
 * one sibling must NOT delete the shared secret while another still-connected instance references
 * it — otherwise the surviving account dies with "credentials missing — RECONNECT_REQUIRED"
 * (the exact dev symptom: disconnect 10 of 11 meta sub-cards → the kept one loses its token).
 *
 * Revert-RED: make deleteSecret unconditional again → the shared-ref test goes RED.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DisconnectCommand,
  ConnectorNotFoundError,
} from '../application/commands/DisconnectCommand.js';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { IConnectorSyncStatusRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import { ConnectorInstance } from '@brain/connector-core';

const BRAND_ID = '550e8400-e29b-41d4-a716-446655440000';
const SHARED_SECRET_REF =
  'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/meta/shared-abc123';

function makeInstance(overrides: {
  id: string;
  accountKey: string;
  status?: 'connected' | 'disconnected' | 'error';
  secretRef?: string;
}): ConnectorInstance {
  return ConnectorInstance.create({
    id: overrides.id,
    brandId: BRAND_ID,
    provider: 'meta',
    shopDomain: '',
    secretRef: overrides.secretRef ?? SHARED_SECRET_REF,
    status: overrides.status ?? 'connected',
    healthState: 'Healthy',
    safetyRating: 'safe',
    connectedAt: new Date(),
    disconnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    accountKey: overrides.accountKey,
  });
}

function makeSecretsManager(): ISecretsManager {
  return {
    storeSecret: vi.fn().mockResolvedValue({ arn: SHARED_SECRET_REF }),
    putSecretValue: vi.fn().mockResolvedValue(undefined),
    getSecret: vi.fn().mockResolvedValue(null),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    storeShopifyToken: vi.fn().mockResolvedValue({ arn: SHARED_SECRET_REF }),
    getShopifyClientSecret: vi.fn().mockResolvedValue(''),
    deleteShopifyToken: vi.fn().mockResolvedValue(undefined),
    getShopifyToken: vi.fn().mockResolvedValue(null),
  } as unknown as ISecretsManager;
}

function makeSyncStatusRepo(): IConnectorSyncStatusRepository {
  return {
    findByConnectorInstanceId: vi.fn().mockResolvedValue(null),
    save: vi.fn(),
    update: vi.fn(),
  } as unknown as IConnectorSyncStatusRepository;
}

function makeConnectorRepo(
  target: ConnectorInstance,
  allForProvider: ConnectorInstance[],
): IConnectorInstanceRepository {
  return {
    findByBrandAndProvider: vi.fn().mockResolvedValue(null),
    findById: vi.fn().mockResolvedValue(target),
    findAllByBrand: vi.fn().mockResolvedValue([]),
    findAllByBrandAndProvider: vi.fn().mockResolvedValue(allForProvider),
    activateAccount: vi.fn().mockResolvedValue(null),
    save: vi.fn(),
    update: vi.fn().mockImplementation((i: ConnectorInstance) => Promise.resolve(i)),
  };
}

describe('DisconnectCommand — shared-secret refcount', () => {
  it('does NOT delete the secret when another still-connected sibling shares the same secret_ref', async () => {
    const target = makeInstance({ id: '11111111-0000-4000-8000-000000000001', accountKey: 'act_1' });
    const sibling = makeInstance({ id: '11111111-0000-4000-8000-000000000002', accountKey: 'act_2' });
    // Post-update state: target already flipped to disconnected; sibling still connected.
    const connectorRepo = makeConnectorRepo(target, [
      makeInstance({ id: target.id, accountKey: 'act_1', status: 'disconnected' }),
      sibling,
    ]);
    const secretsManager = makeSecretsManager();
    const emitEvent = vi.fn().mockResolvedValue(undefined);

    const cmd = new DisconnectCommand(connectorRepo, makeSyncStatusRepo(), secretsManager, emitEvent);
    await cmd.execute({
      connectorInstanceId: target.id,
      brandId: BRAND_ID,
      idempotencyKey: 'idem-1',
    });

    expect(secretsManager.deleteSecret).not.toHaveBeenCalled();
    // The instance itself is still disconnected + the event still fires.
    expect(connectorRepo.update).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith(
      'connector.disconnected',
      expect.objectContaining({ connector_instance_id: target.id }),
    );
  });

  it('does NOT delete the secret when a sibling in ERROR status still references it (live install, transient failure)', async () => {
    const target = makeInstance({ id: '11111111-0000-4000-8000-000000000001', accountKey: 'act_1' });
    // Sibling is 'error' (e.g. rate-limit / re-pull failure) — still a live install that needs the
    // shared secret to recover, so the secret must survive the disconnect of its sibling.
    const errorSibling = makeInstance({
      id: '11111111-0000-4000-8000-000000000003',
      accountKey: 'act_3',
      status: 'error',
    });
    const connectorRepo = makeConnectorRepo(target, [
      makeInstance({ id: target.id, accountKey: 'act_1', status: 'disconnected' }),
      errorSibling,
    ]);
    const secretsManager = makeSecretsManager();

    const cmd = new DisconnectCommand(connectorRepo, makeSyncStatusRepo(), secretsManager, vi.fn().mockResolvedValue(undefined));
    await cmd.execute({ connectorInstanceId: target.id, brandId: BRAND_ID, idempotencyKey: 'idem-err' });

    expect(secretsManager.deleteSecret).not.toHaveBeenCalled();
  });

  it('deletes the secret when the disconnecting instance is the LAST live holder of the secret_ref', async () => {
    const target = makeInstance({ id: '11111111-0000-4000-8000-000000000001', accountKey: 'act_1' });
    // Post-update state: only self (now disconnected) holds the ref.
    const connectorRepo = makeConnectorRepo(target, [
      makeInstance({ id: target.id, accountKey: 'act_1', status: 'disconnected' }),
    ]);
    const secretsManager = makeSecretsManager();

    const cmd = new DisconnectCommand(
      connectorRepo,
      makeSyncStatusRepo(),
      secretsManager,
      vi.fn().mockResolvedValue(undefined),
    );
    await cmd.execute({
      connectorInstanceId: target.id,
      brandId: BRAND_ID,
      idempotencyKey: 'idem-2',
    });

    expect(secretsManager.deleteSecret).toHaveBeenCalledTimes(1);
    expect(secretsManager.deleteSecret).toHaveBeenCalledWith(SHARED_SECRET_REF);
  });

  it('deletes the secret when siblings exist but hold DIFFERENT secret_refs', async () => {
    const target = makeInstance({ id: '11111111-0000-4000-8000-000000000001', accountKey: 'act_1' });
    const otherRefSibling = makeInstance({
      id: '11111111-0000-4000-8000-000000000003',
      accountKey: 'act_3',
      secretRef:
        'arn:aws:secretsmanager:us-east-1:000000000000:secret:brain/connector/meta/other-xyz789',
    });
    const connectorRepo = makeConnectorRepo(target, [
      makeInstance({ id: target.id, accountKey: 'act_1', status: 'disconnected' }),
      otherRefSibling,
    ]);
    const secretsManager = makeSecretsManager();

    const cmd = new DisconnectCommand(
      connectorRepo,
      makeSyncStatusRepo(),
      secretsManager,
      vi.fn().mockResolvedValue(undefined),
    );
    await cmd.execute({
      connectorInstanceId: target.id,
      brandId: BRAND_ID,
      idempotencyKey: 'idem-3',
    });

    expect(secretsManager.deleteSecret).toHaveBeenCalledTimes(1);
    expect(secretsManager.deleteSecret).toHaveBeenCalledWith(SHARED_SECRET_REF);
  });

  it('throws ConnectorNotFoundError when the instance does not exist for the brand', async () => {
    const connectorRepo = makeConnectorRepo(
      makeInstance({ id: '11111111-0000-4000-8000-000000000001', accountKey: 'act_1' }),
      [],
    );
    (connectorRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const cmd = new DisconnectCommand(
      connectorRepo,
      makeSyncStatusRepo(),
      makeSecretsManager(),
      vi.fn(),
    );
    await expect(
      cmd.execute({
        connectorInstanceId: 'missing',
        brandId: BRAND_ID,
        idempotencyKey: 'idem-4',
      }),
    ).rejects.toThrow(ConnectorNotFoundError);
  });
});
