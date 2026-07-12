/**
 * registerConnectorBackfillSyncRoutes — sync / activate / backfill routes (manager+ scope;
 * backfill + jobs re-tightened to brand_admin+).
 *
 * Extracted VERBATIM from bootstrap/registerConnectors.ts. Guards, status codes, and
 * response shapes are byte-for-byte identical to the prior inline registration.
 */
import { type FastifyInstance, type FastifyRequest, type preHandlerAsyncHookHandler } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { DbPool } from '@brain/db';
import type { AuditWriter } from '@brain/audit';
import type { BackfillJobProgress } from '@brain/contracts';

import { PgBackfillJobRepository } from '../../modules/connector/backfill/infrastructure/PgBackfillJobRepository.js';
import { RequestConnectorBackfillCommand } from '../../modules/connector/backfill/application/commands/RequestConnectorBackfillCommand.js';
import { PgSyncRequestRepository } from '../../modules/connector/sync/infrastructure/PgSyncRequestRepository.js';
import { RequestConnectorSyncCommand } from '../../modules/connector/sync/application/commands/RequestConnectorSyncCommand.js';
import { ActivateAdAccountCommand } from '../../modules/connector/sources/advertising/application/commands/ActivateAdAccountCommand.js';
import type { PgConnectorInstanceRepository } from '../../modules/connector/sources/storefront/shopify/infrastructure/repositories/PgConnectorInstanceRepository.js';
import type { ISecretsManager } from '@brain/connector-secrets';
import { requireRole } from '../../modules/workspace-access/internal/security/rbac.js';

import { getBrandId } from './shared.js';

export interface RegisterConnectorBackfillSyncRoutesDeps {
  pool: DbPool;
  connectorRepo: PgConnectorInstanceRepository;
  connectorSecretsManager: ISecretsManager;
  auditWriter: AuditWriter;
  sessionPreHandler: preHandlerAsyncHookHandler;
}

export function registerConnectorBackfillSyncRoutes(app: FastifyInstance, deps: RegisterConnectorBackfillSyncRoutesDeps): void {
  const { pool, connectorRepo, connectorSecretsManager, auditWriter, sessionPreHandler } = deps;

  const backfillJobRepo = new PgBackfillJobRepository(pool);
  const syncRequestRepo = new PgSyncRequestRepository(pool);
  const requestConnectorSync = new RequestConnectorSyncCommand(
    connectorRepo,
    connectorSecretsManager,
    syncRequestRepo,
    auditWriter,
  );
  // CQ-3: extracted RequestConnectorBackfillCommand (mirrors RequestConnectorSyncCommand).
  const requestConnectorBackfill = new RequestConnectorBackfillCommand(
    connectorRepo,
    connectorSecretsManager,
    backfillJobRepo,
    auditWriter,
  );
  // 0106: choose the ONE ad account that ingests per (brand, ad platform). Generic across platforms.
  const activateAdAccount = new ActivateAdAccountCommand(connectorRepo, auditWriter);

  void app.register(async (scope) => {
    scope.addHook('preHandler', sessionPreHandler);
    scope.addHook('preHandler', requireRole('manager'));

    // POST /api/v1/connectors/:id/sync — "Sync now" (feat-connector-sync-now)
    scope.post('/api/v1/connectors/:id/sync', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      const result = await requestConnectorSync.execute({
        connectorInstanceId,
        brandId,
        correlationId: requestId,
        actorId: auth?.userId ?? null,
        actorRole: auth?.role ?? 'unknown',
      });

      if (!result.ok) {
        const httpCode = result.code === 'CONNECTOR_NOT_FOUND' ? 404 : 409;
        return reply.code(httpCode).send({
          request_id: requestId,
          error: { code: result.code, message: result.message },
        });
      }

      return reply.code(202).send({
        request_id: requestId,
        data: {
          connector_instance_id: result.connectorInstanceId,
          status: result.status,
          requested_at: result.requestedAt,
        },
      });
    });

    // 0106 — Activate ONE ad account per (brand, platform). Generic: meta/google_ads/future.
    // Switch semantics — activating this one deactivates its siblings in a single txn.
    scope.post('/api/v1/connectors/:id/activate', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      const result = await activateAdAccount.execute({
        connectorInstanceId,
        brandId,
        correlationId: requestId,
        actorId: auth?.userId ?? null,
        actorRole: auth?.role ?? 'unknown',
      });

      if (!result.ok) {
        const httpCode = result.code === 'CONNECTOR_NOT_FOUND' ? 404 : 409;
        return reply.code(httpCode).send({
          request_id: requestId,
          error: { code: result.code, message: result.message },
        });
      }

      return reply.code(200).send({
        request_id: requestId,
        data: {
          connector_instance_id: result.connectorInstanceId,
          provider: result.provider,
          account_key: result.accountKey,
          activated_at: result.activatedAt,
        },
      });
    });

    // B1 — Backfill trigger (ADR-BF-3). Re-tighten to brand_admin+ (Manager → 403).
    // CQ-3: thin route → RequestConnectorBackfillCommand.execute().
    scope.post<{ Params: { id: string } }>('/api/v1/connectors/:id/backfill', { preHandler: requireRole('brand_admin') }, async (req, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;
      const auth = (req as typeof req & { auth?: { userId?: string; role?: string } }).auth;

      const result = await requestConnectorBackfill.execute({
        connectorInstanceId,
        brandId,
        correlationId: requestId,
        actorId: auth?.userId ?? null,
        actorRole: auth?.role ?? 'unknown',
      });

      if (!result.ok) {
        const httpCode =
          result.code === 'CONNECTOR_NOT_FOUND'
            ? 404
            : result.code === 'BACKFILL_NOT_SUPPORTED'
              ? 400
              : 409;
        return reply.code(httpCode).send({
          request_id: requestId,
          error: { code: result.code, message: result.message },
        });
      }

      return reply.code(202).send({
        request_id: requestId,
        data: { job_id: result.jobId, status: result.status },
      });
    });

    // B2 — Progress API (ADR-BF-4)
    scope.get<{ Params: { id: string } }>('/api/v1/connectors/:id/jobs', { preHandler: requireRole('brand_admin') }, async (req, reply) => {
      const requestId = (req.id as string) ?? randomUUID();
      const brandId = getBrandId(req);
      const connectorInstanceId = req.params.id;

      const connectorInstance = await connectorRepo.findById(connectorInstanceId, brandId);
      if (!connectorInstance) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'CONNECTOR_NOT_FOUND', message: 'Connector not found for this brand.' },
        });
      }

      const job = await backfillJobRepo.findLatestForConnector(connectorInstanceId, brandId, requestId);
      if (!job) {
        return reply.code(404).send({
          request_id: requestId,
          error: { code: 'NO_BACKFILL_JOB', message: 'No backfill job found for this connector.' },
        });
      }

      const recordsProcessed = parseInt(job.records_processed, 10);
      const estimatedTotal = job.estimated_total !== null ? parseInt(job.estimated_total, 10) : null;
      const percent =
        estimatedTotal !== null && estimatedTotal > 0
          ? Math.min(100, Math.round((recordsProcessed / estimatedTotal) * 100))
          : null;

      const progress: BackfillJobProgress = {
        job_id: job.id,
        status: job.status,
        records_processed: recordsProcessed,
        estimated_total: estimatedTotal,
        percent,
        cursor_date: job.cursor_date ?? null,
        achieved_depth_label: job.achieved_depth_label ?? null,
        failure_reason: job.failure_reason ?? null,
        started_at: job.started_at ?? null,
        completed_at: job.completed_at ?? null,
      };

      return reply.code(200).send({
        request_id: requestId,
        data: progress,
      });
    });
  });
}
