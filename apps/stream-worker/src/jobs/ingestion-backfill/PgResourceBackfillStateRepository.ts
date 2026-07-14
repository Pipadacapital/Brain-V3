/**
 * PgResourceBackfillStateRepository — the jobs.resource_backfill_state (migration 0111) adapter for
 * @brain/connector-core's IResourceBackfillStateRepository.
 *
 * This is the durable home of the RESUMABLE backfill frontier: per (brand, connector_instance,
 * resource) it persists the checkpointed chunk cursor, the deepest occurred_at reached, the
 * resumable status, and a lifetime processed count. `runResumableBackfill` upserts it after EVERY
 * chunk, so a paused/crashed run resumes exactly where it left off (never restarts).
 *
 * RLS (born-secure, 0111): the table is FORCE RLS with a two-arg fail-closed policy on
 * app.current_brand_id. Every read/write therefore sets the brand GUC inside a txn FIRST (MT-1 /
 * NN-1). brain_app has SELECT/INSERT/UPDATE only (no DELETE) — a fresh backfill re-uses the row via
 * upsert. brand_id ALWAYS comes from the caller (the enumeration fn / connector row), never a
 * payload.
 */

import type { Pool } from 'pg';
import { buildContextGucSql } from '@brain/db';
import {
  ResourceBackfillState,
  type ResourceBackfillStateProps,
  type ResourceBackfillStatus,
  type IResourceBackfillStateRepository,
} from '@brain/connector-core';

interface BackfillStateRow {
  id: string;
  brand_id: string;
  connector_instance_id: string;
  resource: string;
  status: ResourceBackfillStatus;
  anchor_at: Date;
  floor_at: Date;
  cursor_value: string | null;
  reached_at: Date | null;
  records_processed: string; // BIGINT as string
  failure_reason: string | null;
  updated_at: Date;
}

function rowToEntity(row: BackfillStateRow): ResourceBackfillState {
  const props: ResourceBackfillStateProps = {
    id: row.id,
    brandId: row.brand_id,
    connectorInstanceId: row.connector_instance_id,
    resource: row.resource,
    status: row.status,
    anchorAt: new Date(row.anchor_at),
    floorAt: new Date(row.floor_at),
    cursor: row.cursor_value,
    reachedAt: row.reached_at ? new Date(row.reached_at) : null,
    recordsProcessed: Number(row.records_processed),
    failureReason: row.failure_reason,
    updatedAt: new Date(row.updated_at),
  };
  return ResourceBackfillState.create(props);
}

export class PgResourceBackfillStateRepository implements IResourceBackfillStateRepository {
  constructor(private readonly pool: Pool) {}

  async findByResource(
    brandId: string,
    connectorInstanceId: string,
    resource: string,
  ): Promise<ResourceBackfillState | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(buildContextGucSql({ brandId: brandId, correlationId: '' }));
      const res = await client.query<BackfillStateRow>(
        `SELECT id, brand_id, connector_instance_id, resource, status, anchor_at, floor_at,
                cursor_value, reached_at, records_processed, failure_reason, updated_at
           FROM jobs.resource_backfill_state
          WHERE brand_id = $1 AND connector_instance_id = $2 AND resource = $3`,
        [brandId, connectorInstanceId, resource],
      );
      await client.query('COMMIT');
      const row = res.rows[0];
      return row ? rowToEntity(row) : null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listByConnector(
    brandId: string,
    connectorInstanceId: string,
  ): Promise<readonly ResourceBackfillState[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(buildContextGucSql({ brandId: brandId, correlationId: '' }));
      const res = await client.query<BackfillStateRow>(
        `SELECT id, brand_id, connector_instance_id, resource, status, anchor_at, floor_at,
                cursor_value, reached_at, records_processed, failure_reason, updated_at
           FROM jobs.resource_backfill_state
          WHERE brand_id = $1 AND connector_instance_id = $2
          ORDER BY resource ASC`,
        [brandId, connectorInstanceId],
      );
      await client.query('COMMIT');
      return res.rows.map(rowToEntity);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async listByStatus(
    brandId: string,
    connectorInstanceId: string,
    status: ResourceBackfillStatus,
  ): Promise<readonly ResourceBackfillState[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(buildContextGucSql({ brandId: brandId, correlationId: '' }));
      const res = await client.query<BackfillStateRow>(
        `SELECT id, brand_id, connector_instance_id, resource, status, anchor_at, floor_at,
                cursor_value, reached_at, records_processed, failure_reason, updated_at
           FROM jobs.resource_backfill_state
          WHERE brand_id = $1 AND connector_instance_id = $2 AND status = $3
          ORDER BY updated_at ASC`,
        [brandId, connectorInstanceId, status],
      );
      await client.query('COMMIT');
      return res.rows.map(rowToEntity);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Upsert on the (brand_id, connector_instance_id, resource) triple. Sets the brand GUC first
   * (FORCE RLS) and writes every mutable column; created_at is untouched on conflict. The all-zero
   * user/workspace GUC is not needed here (the policy only reads app.current_brand_id).
   */
  async upsert(state: ResourceBackfillState): Promise<ResourceBackfillState> {
    const p = state.toProps();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(buildContextGucSql({ brandId: p.brandId, correlationId: '' }));
      await client.query(
        `INSERT INTO jobs.resource_backfill_state
           (id, brand_id, connector_instance_id, resource, status, anchor_at, floor_at,
            cursor_value, reached_at, records_processed, failure_reason, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::bigint, $11, $12)
         ON CONFLICT ON CONSTRAINT resource_backfill_state_upsert_key
         DO UPDATE SET
            status            = EXCLUDED.status,
            anchor_at         = EXCLUDED.anchor_at,
            floor_at          = EXCLUDED.floor_at,
            cursor_value      = EXCLUDED.cursor_value,
            reached_at        = EXCLUDED.reached_at,
            records_processed = EXCLUDED.records_processed,
            failure_reason    = EXCLUDED.failure_reason,
            updated_at        = EXCLUDED.updated_at`,
        [
          p.id,
          p.brandId,
          p.connectorInstanceId,
          p.resource,
          p.status,
          p.anchorAt.toISOString(),
          p.floorAt.toISOString(),
          p.cursor,
          p.reachedAt ? p.reachedAt.toISOString() : null,
          String(p.recordsProcessed),
          p.failureReason,
          p.updatedAt.toISOString(),
        ],
      );
      await client.query('COMMIT');
      return state;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
