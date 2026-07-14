/**
 * RequestConnectorSyncCommand — the on-demand "Sync now" trigger (feat-connector-sync-now).
 *
 * Mirrors the backfill trigger step-for-step (apps/core/src/main.ts:1054-1119) but for
 * the INCREMENTAL trailing-window re-pull lane (NOT a full backfill). It enqueues a
 * one-shot sync request that the in-worker claimer turns into the SAME
 * run(connectorInstanceId) the scheduler invokes — the "same code path" principle.
 *
 * DDD: the route in main.ts is thin; this command orchestrates steps 3-8.
 *
 * Invariants honored:
 *   - MT-1: brand_id is passed in from the session (getBrandId(req)) — NEVER from the body.
 *           Every DB op runs under app.current_brand_id (RLS FORCE, verified under brain_app).
 *   - Overlap-lock REUSE: two fast pre-checks (pending-request dedup + in-flight state);
 *           the AUTHORITATIVE lock is run()'s own FOR UPDATE SKIP LOCKED on the live cursor
 *           row, so even if both pre-checks pass a late manual run is a no-op skip.
 *   - I-S09: NO token value is ever read into a response/log; secret presence is checked via
 *           getSecret(secretRef) === null only.
 *   - Same-code-path: no new topic/envelope; the claimer dispatches the existing repull run().
 */

import type { AuditWriter } from '@brain/audit';
import type { IConnectorInstanceRepository } from '@brain/connector-core';
import type { ISecretsManager } from '@brain/connector-secrets';
import { PgSyncRequestRepository } from '../../infrastructure/PgSyncRequestRepository.js';

/** Provider → the repull cursor resource the scheduler locks (informational / dispatch). */
const PROVIDER_REPULL_RESOURCE: Record<string, string> = {
  shopify: 'orders.repull',
  razorpay: 'settlements.payments',
  meta: 'meta.insights',
  google_ads: 'google_ads.spend',
  gokwik: 'awb.lifecycle', // gokwik has a trailing-window AWB-lifecycle repull → on-demand syncable
  shiprocket: 'shipment.lifecycle', // shiprocket trailing-window shipment-lifecycle repull → on-demand syncable
  woocommerce: 'orders.repull', // woocommerce REST order backfill/incremental repull → on-demand syncable
};

export type SyncRequestErrorCode =
  | 'CONNECTOR_NOT_FOUND'
  | 'RECONNECT_REQUIRED'
  | 'SYNC_ALREADY_REQUESTED'
  | 'SYNC_ALREADY_RUNNING'
  | 'CONNECTOR_NOT_SYNCABLE';

export interface SyncRequestSuccess {
  ok: true;
  connectorInstanceId: string;
  status: 'syncing';
  requestedAt: string;
}

export interface SyncRequestFailure {
  ok: false;
  code: SyncRequestErrorCode;
  message: string;
}

export type SyncRequestResult = SyncRequestSuccess | SyncRequestFailure;

export interface RequestConnectorSyncInput {
  connectorInstanceId: string;
  /** brand_id from the SESSION (getBrandId) — never the request body (MT-1). */
  brandId: string;
  correlationId: string;
  actorId: string | null;
  actorRole: string;
}

export class RequestConnectorSyncCommand {
  constructor(
    private readonly connectorRepo: IConnectorInstanceRepository,
    private readonly secretsManager: ISecretsManager,
    private readonly syncRequestRepo: PgSyncRequestRepository,
    private readonly auditWriter: AuditWriter,
  ) {}

  async execute(input: RequestConnectorSyncInput): Promise<SyncRequestResult> {
    const { connectorInstanceId, brandId, correlationId, actorId, actorRole } = input;

    // Step 1: Load connector_instance — brand-scoped (RLS FORCE / MT-1).
    const connector = await this.connectorRepo.findById(connectorInstanceId, brandId);
    if (!connector) {
      return {
        ok: false,
        code: 'CONNECTOR_NOT_FOUND',
        message: 'Connector not found for this brand.',
      };
    }

    // Only providers with a trailing-window re-pull job are syncable on demand.
    const repullResource = PROVIDER_REPULL_RESOURCE[connector.provider];
    if (!repullResource) {
      return {
        ok: false,
        code: 'CONNECTOR_NOT_SYNCABLE',
        message: `On-demand sync is not available for ${connector.provider}.`,
      };
    }

    // Step 2: token presence — getSecret(secretRef) === null ⇒ RECONNECT_REQUIRED.
    // NO token value is logged or returned (I-S09).
    const secret = await this.secretsManager.getSecret(connector.secretRef);
    if (secret === null) {
      return {
        ok: false,
        code: 'RECONNECT_REQUIRED',
        message: 'Your connection has expired. Please reconnect before syncing.',
      };
    }

    // Step 3 (5b): in-flight pre-check — honest "already syncing" (not a duplicate run).
    const syncState = await this.syncRequestRepo.readSyncState(
      connectorInstanceId,
      brandId,
      correlationId,
    );
    if (syncState?.state === 'syncing') {
      return {
        ok: false,
        code: 'SYNC_ALREADY_RUNNING',
        message: 'This connector is already syncing.',
      };
    }

    // Step 4 (5a): request-dedup pre-check — a request is already queued.
    const pending = await this.syncRequestRepo.checkPendingRequest(
      connectorInstanceId,
      brandId,
      correlationId,
    );
    if (pending !== null) {
      return {
        ok: false,
        code: 'SYNC_ALREADY_REQUESTED',
        message: 'A sync is already queued for this connector.',
      };
    }

    // Step 5: enqueue the sentinel request row (the "same command the scheduler emits").
    const requestedAt = await this.syncRequestRepo.enqueueRequest(
      connectorInstanceId,
      brandId,
      correlationId,
    );

    // Step 6: audit connector.sync.requested — NO secret_ref / token (I-S09).
    await this.auditWriter.append({
      brand_id: brandId,
      actor_id: actorId,
      actor_role: actorRole,
      action: 'connector.sync.requested',
      entity_type: 'connector_instance',
      entity_id: connectorInstanceId,
      payload: {
        connector_instance_id: connectorInstanceId,
        provider: connector.provider,
        requested_at: requestedAt,
        // NO secret_ref, NO token (I-S09).
      },
    });

    return {
      ok: true,
      connectorInstanceId,
      status: 'syncing',
      requestedAt,
    };
  }
}
