/**
 * backfill-not-supported.unit.test.ts — unit coverage for the Step-1.5 reject guard
 * (RequestConnectorBackfillCommand): a provider with NO backfill-queue runner must be rejected
 * with BACKFILL_NOT_SUPPORTED *before* any secret read / DB insert / audit write, so it can never
 * orphan a `jobs.backfill_job` row that nothing claims.
 *
 * Single source of truth = @brain/connector-core supportsBackfillQueue (BACKFILL_QUEUE_PROVIDERS),
 * shared with the stream-worker claimer (apps/stream-worker/src/main.ts) — currently `shopify` only.
 *
 * Pure unit test (no DB): the only collaborator exercised is connectorRepo.findById; the secrets
 * manager / job repo / audit writer are stubs that MUST NOT be called on the reject path.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AuditWriter } from '@brain/audit';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import { RequestConnectorBackfillCommand } from '../application/commands/RequestConnectorBackfillCommand.js';
import { PgBackfillJobRepository } from '../infrastructure/PgBackfillJobRepository.js';

function makeCommand(provider: string | null) {
  // connectorRepo: findById returns an instance carrying `provider` (or null = not found).
  const findById = vi.fn().mockResolvedValue(
    provider === null
      ? null
      : { id: 'ci-1', brandId: 'brand-1', provider, secretRef: 'secret://ci-1' },
  );
  const connectorRepo = { findById } as unknown as IConnectorInstanceRepository;

  // These collaborators must NEVER be reached on the reject path — spy to prove it.
  const getSecret = vi.fn().mockResolvedValue('a-token');
  const secretsManager = { getSecret } as unknown as ISecretsManager;

  const checkActiveJob = vi.fn().mockResolvedValue(null);
  const insertQueued = vi.fn().mockResolvedValue('job-1');
  const backfillJobRepo = { checkActiveJob, insertQueued } as unknown as PgBackfillJobRepository;

  const append = vi.fn().mockResolvedValue(undefined);
  const auditWriter = { append } as unknown as AuditWriter;

  const command = new RequestConnectorBackfillCommand(
    connectorRepo,
    secretsManager,
    backfillJobRepo,
    auditWriter,
  );
  return { command, findById, getSecret, checkActiveJob, insertQueued, append };
}

const INPUT = {
  connectorInstanceId: 'ci-1',
  brandId: 'brand-1',
  correlationId: 'corr-1',
  actorId: 'actor-1',
  actorRole: 'brand_admin',
};

describe('RequestConnectorBackfillCommand — BACKFILL_NOT_SUPPORTED guard', () => {
  // Every provider that has NO jobs.backfill_job claimer must be rejected, never enqueued.
  it.each(['meta', 'google_ads', 'gokwik', 'razorpay', 'shiprocket', 'woocommerce'])(
    'rejects %s with BACKFILL_NOT_SUPPORTED before touching secrets/DB/audit',
    async (provider) => {
      const { command, getSecret, checkActiveJob, insertQueued, append } = makeCommand(provider);

      const result = await command.execute(INPUT);

      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ code: 'BACKFILL_NOT_SUPPORTED' });
      // Short-circuit proof: no secret read, no overlap-lock, no insert, no audit row.
      expect(getSecret).not.toHaveBeenCalled();
      expect(checkActiveJob).not.toHaveBeenCalled();
      expect(insertQueued).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
    },
  );

  it('lets shopify (the one provider with a claimer) PAST the guard into Step 2', async () => {
    const { command, getSecret } = makeCommand('shopify');

    await command.execute(INPUT);

    // The guard did not reject shopify — execution advanced to the secret read (Step 2).
    expect(getSecret).toHaveBeenCalledTimes(1);
  });

  it('still returns CONNECTOR_NOT_FOUND when the instance is absent (guard is after Step 1)', async () => {
    const { command, getSecret } = makeCommand(null);

    const result = await command.execute(INPUT);

    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_NOT_FOUND' });
    expect(getSecret).not.toHaveBeenCalled();
  });
});
