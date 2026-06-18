/**
 * PgSyncRequestRepository (core-side adapter) — on-demand "Sync now" request queue.
 *
 * feat-connector-sync-now / architecture §3, §6 Track A.
 *
 * NO MIGRATION: the sync-request signal is a sentinel row in the EXISTING
 * `connector_cursor` table (resource = SYNC_REQUEST_RESOURCE = 'sync.request'),
 * one per (brand_id, connector_instance_id). `cursor_value` IS the request state:
 *   - non-empty ISO timestamp ⇒ PENDING (a sync was requested, not yet claimed)
 *   - empty string ''         ⇒ TOMBSTONE (claimed/consumed by the worker)
 * The worker CONSUMES a request by UPDATE-ing cursor_value to '' — NOT a DELETE,
 * because brain_app is granted only SELECT/INSERT/UPDATE on connector_cursor (no
 * DELETE; verified by the live test under brain_app — a DELETE 42501s). This is the
 * "same command the scheduler emits" — the in-worker claimer
 * (apps/stream-worker/src/jobs/sync-request-claimer) turns the pending sentinel into
 * the identical run(connectorInstanceId) call the scheduler invokes.
 *
 * Uses @brain/db DbPool with QueryContext (GUC-based RLS, NN-1) — every query runs
 * under app.current_brand_id so RLS FORCE on connector_cursor / connector_sync_status
 * enforces brand isolation. Mirrors PgBackfillJobRepository.
 *
 * The AUTHORITATIVE overlap-lock is INSIDE the repull run() (its own FOR UPDATE SKIP
 * LOCKED on the live cursor row). The two checks here are fast UX pre-checks:
 *   - checkPendingRequest: dedup a second click before the claimer runs (SYNC_ALREADY_REQUESTED)
 *   - readSyncState:       honest "already syncing" if state='syncing' (SYNC_ALREADY_RUNNING)
 */

import type { DbPool, QueryContext } from '@brain/db';

/** Sentinel cursor resource for the on-demand sync request signal (provider-agnostic). */
export const SYNC_REQUEST_RESOURCE = 'sync.request' as const;

export type SyncStateValue = 'connected' | 'syncing' | 'waiting_for_data' | 'error';

export interface SyncStateRow {
  state: SyncStateValue;
  last_sync_at: string | null;
  last_error: string | null;
}

export class PgSyncRequestRepository {
  constructor(private readonly pool: DbPool) {}

  /**
   * Pre-check (5a): is a sync request already PENDING for this connector?
   * SELECT ... FOR UPDATE SKIP LOCKED on the sentinel connector_cursor row, filtering to
   * a non-empty cursor_value (an empty '' is a consumed tombstone — NOT pending). Returns
   * the pending request timestamp or null. Caller returns 409 SYNC_ALREADY_REQUESTED.
   * Runs brand-scoped (RLS FORCE).
   */
  async checkPendingRequest(
    connectorInstanceId: string,
    brandId: string,
    correlationId: string,
  ): Promise<string | null> {
    const ctx: QueryContext = { brandId, correlationId };
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ cursor_value: string | null }>(
        ctx,
        `SELECT cursor_value
           FROM connector_cursor
          WHERE brand_id = $1
            AND connector_instance_id = $2
            AND resource = $3
            AND cursor_value IS NOT NULL
            AND cursor_value <> ''
          FOR UPDATE SKIP LOCKED`,
        [brandId, connectorInstanceId, SYNC_REQUEST_RESOURCE],
      );
      return result.rows[0]?.cursor_value ?? null;
    } finally {
      client.release();
    }
  }

  /**
   * Read the live sync state for the connector (5b in-flight pre-check + status surface).
   * Returns null when no sync_status row exists yet (never synced).
   */
  async readSyncState(
    connectorInstanceId: string,
    brandId: string,
    correlationId: string,
  ): Promise<SyncStateRow | null> {
    const ctx: QueryContext = { brandId, correlationId };
    const client = await this.pool.connect();
    try {
      const result = await client.query<SyncStateRow>(
        ctx,
        `SELECT state,
                last_sync_at::text AS last_sync_at,
                last_error
           FROM connector_sync_status
          WHERE brand_id = $1
            AND connector_instance_id = $2`,
        [brandId, connectorInstanceId],
      );
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  /**
   * Enqueue the sync request — upsert the sentinel connector_cursor row with
   * cursor_value = now ISO. Idempotent on (brand_id, connector_instance_id, resource):
   * a re-click just refreshes the timestamp (no duplicate). Brand-scoped (NN-1 / RLS).
   *
   * This is the "emit the same sync command the scheduler emits": the claimer reads
   * this sentinel and dispatches the identical run(connectorInstanceId).
   */
  async enqueueRequest(
    connectorInstanceId: string,
    brandId: string,
    correlationId: string,
  ): Promise<string> {
    const requestedAt = new Date().toISOString();
    const ctx: QueryContext = { brandId, correlationId };
    const client = await this.pool.connect();
    try {
      await client.query(
        ctx,
        `INSERT INTO connector_cursor
           (brand_id, connector_instance_id, resource, cursor_value, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT ON CONSTRAINT connector_cursor_upsert_key
         DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = NOW()`,
        [brandId, connectorInstanceId, SYNC_REQUEST_RESOURCE, requestedAt],
      );
      return requestedAt;
    } finally {
      client.release();
    }
  }
}
