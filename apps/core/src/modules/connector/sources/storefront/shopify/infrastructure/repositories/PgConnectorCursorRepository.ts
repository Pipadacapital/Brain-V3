/**
 * PgConnectorCursorRepository — Postgres-backed repository for connector_cursor.
 *
 * Idempotent upsert on (brand_id, connector_instance_id, resource) (I-ST04).
 * Replay-safe: re-running the same cursor write is a no-op or advances the cursor.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { IConnectorCursorRepository } from '../../domain/repositories/IConnectorCursorRepository.js';
import { ConnectorCursor } from '../../domain/entities/ConnectorCursor.js';

interface CursorRow {
  id: string;
  brand_id: string;
  connector_instance_id: string;
  resource: string;
  cursor_value: string | null;
  updated_at: Date;
}

function rowToEntity(row: CursorRow): ConnectorCursor {
  return ConnectorCursor.create({
    id: row.id,
    brandId: row.brand_id,
    connectorInstanceId: row.connector_instance_id,
    resource: row.resource,
    cursorValue: row.cursor_value,
    updatedAt: new Date(row.updated_at),
  });
}

export class PgConnectorCursorRepository implements IConnectorCursorRepository {
  constructor(private readonly pool: DbPool) {}

  async findByResource(
    brandId: string,
    connectorInstanceId: string,
    resource: string,
  ): Promise<ConnectorCursor | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<CursorRow>(
        ctx,
        `SELECT id, brand_id, connector_instance_id, resource, cursor_value, updated_at
         FROM connector_cursor
         WHERE brand_id = $1 AND connector_instance_id = $2 AND resource = $3`,
        [brandId, connectorInstanceId, resource],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async upsert(cursor: ConnectorCursor): Promise<ConnectorCursor> {
    const ctx: QueryContext = { brandId: cursor.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      // Idempotent upsert on the (brand_id, connector_instance_id, resource) unique key (I-ST04).
      const result = await client.query<CursorRow>(
        ctx,
        `INSERT INTO connector_cursor
           (id, brand_id, connector_instance_id, resource, cursor_value, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (brand_id, connector_instance_id, resource)
         DO UPDATE SET
           cursor_value = EXCLUDED.cursor_value,
           updated_at   = EXCLUDED.updated_at
         RETURNING id, brand_id, connector_instance_id, resource, cursor_value, updated_at`,
        [
          cursor.id,
          cursor.brandId,
          cursor.connectorInstanceId,
          cursor.resource,
          cursor.cursorValue,
          cursor.updatedAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorCursorRepository] UPSERT returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }
}
