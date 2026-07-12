/**
 * RequestConnectorBackfillCommand (CQ-3) — the backfill trigger (ADR-BF-3).
 *
 * EXTRACTED from the inline `POST /api/v1/connectors/:id/backfill` handler that lived in
 * apps/core/src/main.ts. Mirrors RequestConnectorSyncCommand step-for-step, but for the
 * FULL backfill lane (not the incremental trailing-window re-pull):
 *
 *   1. Load connector_instance (brand-scoped, NN-1 RLS).
 *   2. getSecret(secret_ref) — null ⇒ RECONNECT_REQUIRED (D-7).
 *   3. Overlap-lock: backfill_job FOR UPDATE SKIP LOCKED ⇒ BACKFILL_ALREADY_RUNNING (D-9/HP-2).
 *   4. INSERT backfill_job status=queued.
 *   5. Audit connector.backfill.requested (NO secret_ref/token — I-S09).
 *
 * The route in main.ts is now thin: build the input from the session + params and map the
 * result to HTTP. Behavior is byte-for-byte identical to the prior inline handler.
 *
 * Invariants honored:
 *   - MT-1: brand_id from the session (getBrandId) — NEVER the body. All DB ops under RLS.
 *   - I-S09: NO token value is read into a response/log; secret presence checked via
 *     getSecret(secretRef) === null only.
 */

import type { AuditWriter } from '@brain/audit';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import { supportsHistoricalBackfill } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import { PgBackfillJobRepository } from '../../infrastructure/PgBackfillJobRepository.js';

export type BackfillRequestErrorCode =
  | 'CONNECTOR_NOT_FOUND'
  | 'BACKFILL_NOT_SUPPORTED'
  | 'RECONNECT_REQUIRED'
  | 'BACKFILL_ALREADY_RUNNING';

export interface BackfillRequestSuccess {
  ok: true;
  jobId: string;
  status: 'queued';
}

export interface BackfillRequestFailure {
  ok: false;
  code: BackfillRequestErrorCode;
  message: string;
}

export type BackfillRequestResult = BackfillRequestSuccess | BackfillRequestFailure;

export interface RequestConnectorBackfillInput {
  connectorInstanceId: string;
  /** brand_id from the SESSION (getBrandId) — never the request body (MT-1). */
  brandId: string;
  correlationId: string;
  actorId: string | null;
  actorRole: string;
  /**
   * OPTIONAL caller-requested historical depth in ms (BackfillTriggerRequest.requested_window_ms,
   * 0127). Persisted verbatim on the queued job; the claimers clamp to the provider manifest's
   * maxBackfillWindowMs at execution time. undefined = provider max (pre-0127 behaviour).
   */
  requestedWindowMs?: number;
}

export class RequestConnectorBackfillCommand {
  constructor(
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly backfillJobRepo: PgBackfillJobRepository,
    private readonly auditWriter: AuditWriter,
  ) {}

  async execute(input: RequestConnectorBackfillInput): Promise<BackfillRequestResult> {
    const { connectorInstanceId, brandId, correlationId, actorId, actorRole } = input;

    // Sanitize the OPTIONAL requested depth (body-sourced, so never trusted): only a positive
    // finite safe integer is persisted; anything else degrades to undefined = provider max. The
    // window is a REQUEST — claimers clamp to the provider manifest's maxBackfillWindowMs, so a
    // huge value can never widen a backfill past the platform cap.
    const requestedWindowMs =
      typeof input.requestedWindowMs === 'number' &&
      Number.isSafeInteger(input.requestedWindowMs) &&
      input.requestedWindowMs > 0
        ? input.requestedWindowMs
        : undefined;

    // Step 1: Load connector_instance (brand-scoped via RLS — NN-1).
    const connectorInstance = await this.connectorRepo.findById(connectorInstanceId, brandId);
    if (!connectorInstance) {
      return {
        ok: false,
        code: 'CONNECTOR_NOT_FOUND',
        message: 'Connector not found for this brand.',
      };
    }

    // Step 1.5: reject providers with NO backfill runner (single source of truth:
    // @brain/connector-core supportsHistoricalBackfill, shared with the stream-worker claimer). A
    // provider is accepted iff it is drained by EITHER the bespoke shopify queue runner
    // (BACKFILL_QUEUE_PROVIDERS) OR the generic ingestion framework (INGESTION_BACKFILL_PROVIDERS:
    // meta/google_ads/razorpay/shiprocket/ga4). GoKwik (webhook-first) has no claimer for
    // jobs.backfill_job — enqueuing one would orphan it as `queued` forever. Fail fast & clearly
    // instead of silently inserting an un-drainable row.
    if (!supportsHistoricalBackfill(connectorInstance.provider)) {
      return {
        ok: false,
        code: 'BACKFILL_NOT_SUPPORTED',
        message: `Historical backfill is not supported for ${connectorInstance.provider} connectors.`,
      };
    }

    // Step 2: getSecret(secret_ref) — if null ⇒ RECONNECT_REQUIRED (D-7).
    // NO token value is ever logged or included in any response (I-S09).
    const secret = await this.secretsManager.getSecret(connectorInstance.secretRef);
    if (secret === null) {
      return {
        ok: false,
        code: 'RECONNECT_REQUIRED',
        message:
          `Your ${connectorInstance.provider} connection has expired. Please reconnect before backfilling.`,
      };
    }

    // Step 3: Overlap-lock — SELECT FOR UPDATE SKIP LOCKED (D-9 / HP-2 — DB-level, not in-process).
    const activeJobId = await this.backfillJobRepo.checkActiveJob(
      connectorInstanceId,
      brandId,
      correlationId,
    );
    if (activeJobId !== null) {
      return {
        ok: false,
        code: 'BACKFILL_ALREADY_RUNNING',
        message: 'A backfill job is already queued or running for this connector.',
      };
    }

    // Step 4: INSERT backfill_job status=queued (carrying the sanitized requested depth, 0127).
    const jobId = await this.backfillJobRepo.insertQueued(
      brandId,
      connectorInstanceId,
      correlationId,
      requestedWindowMs ?? null,
    );

    // Step 5: Audit connector.backfill.requested — actor, connector_instance_id, brand_id.
    // NO secret_ref, NO token in payload (I-S09 / I-S02).
    await this.auditWriter.append({
      brand_id: brandId,
      actor_id: actorId,
      actor_role: actorRole,
      action: 'connector.backfill.requested',
      entity_type: 'backfill_job',
      entity_id: jobId,
      payload: {
        job_id: jobId,
        connector_instance_id: connectorInstanceId,
        // Requested depth (ms) — auditable, non-secret. null = provider max.
        requested_window_ms: requestedWindowMs ?? null,
        // NO secret_ref, NO token (I-S09)
      },
    });

    return { ok: true, jobId, status: 'queued' };
  }
}
