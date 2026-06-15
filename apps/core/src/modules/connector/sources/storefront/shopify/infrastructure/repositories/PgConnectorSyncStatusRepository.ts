/**
 * PgConnectorSyncStatusRepository — Postgres-backed repository for connector_sync_status.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { IConnectorSyncStatusRepository } from '../../domain/repositories/IConnectorSyncStatusRepository.js';
import { ConnectorSyncStatus } from '../../domain/entities/ConnectorSyncStatus.js';
import type { SyncState } from '../../domain/entities/ConnectorSyncStatus.js';

interface SyncStatusRow {
  id: string;
  brand_id: string;
  connector_instance_id: string;
  state: SyncState;
  last_sync_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

function rowToEntity(row: SyncStatusRow): ConnectorSyncStatus {
  return ConnectorSyncStatus.create({
    id: row.id,
    brandId: row.brand_id,
    connectorInstanceId: row.connector_instance_id,
    state: row.state,
    lastSyncAt: row.last_sync_at ? new Date(row.last_sync_at) : null,
    lastError: row.last_error,
    updatedAt: new Date(row.updated_at),
  });
}

export class PgConnectorSyncStatusRepository implements IConnectorSyncStatusRepository {
  constructor(private readonly pool: DbPool) {}

  async findByConnectorInstanceId(
    connectorInstanceId: string,
    brandId: string,
  ): Promise<ConnectorSyncStatus | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<SyncStatusRow>(
        ctx,
        `SELECT id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at
         FROM connector_sync_status
         WHERE connector_instance_id = $1 AND brand_id = $2`,
        [connectorInstanceId, brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async save(status: ConnectorSyncStatus): Promise<ConnectorSyncStatus> {
    const ctx: QueryContext = { brandId: status.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<SyncStatusRow>(
        ctx,
        `INSERT INTO connector_sync_status
           (id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at`,
        [
          status.id,
          status.brandId,
          status.connectorInstanceId,
          status.state,
          status.lastSyncAt?.toISOString() ?? null,
          status.lastError,
          status.updatedAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorSyncStatusRepository] INSERT returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  async update(status: ConnectorSyncStatus): Promise<ConnectorSyncStatus> {
    const ctx: QueryContext = { brandId: status.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<SyncStatusRow>(
        ctx,
        `UPDATE connector_sync_status
         SET state = $1, last_sync_at = $2, last_error = $3, updated_at = $4
         WHERE id = $5 AND brand_id = $6
         RETURNING id, brand_id, connector_instance_id, state, last_sync_at, last_error, updated_at`,
        [
          status.state,
          status.lastSyncAt?.toISOString() ?? null,
          status.lastError,
          status.updatedAt.toISOString(),
          status.id,
          status.brandId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorSyncStatusRepository] UPDATE returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }
}
