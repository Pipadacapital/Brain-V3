/**
 * PgConnectorInstanceRepository — Postgres-backed repository for connector_instance.
 *
 * All queries are brand-scoped via the QueryContext (sets app.current_brand_id GUC)
 * which combines with RLS to enforce tenant isolation (NN-1).
 *
 * NN-2: secret_ref is the only credential column — no token bytes are read/written.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { IConnectorInstanceRepository } from '../../domain/repositories/IConnectorInstanceRepository.js';
import { ConnectorInstance } from '../../domain/entities/ConnectorInstance.js';
import type { ConnectorInstanceProps } from '../../domain/entities/ConnectorInstance.js';

interface ConnectorInstanceRow {
  id: string;
  brand_id: string;
  provider: 'shopify';
  shop_domain: string;
  secret_ref: string;
  status: 'connected' | 'disconnected' | 'error';
  connected_at: Date;
  disconnected_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToEntity(row: ConnectorInstanceRow): ConnectorInstance {
  return ConnectorInstance.create({
    id: row.id,
    brandId: row.brand_id,
    provider: row.provider,
    shopDomain: row.shop_domain,
    secretRef: row.secret_ref,
    status: row.status,
    connectedAt: new Date(row.connected_at),
    disconnectedAt: row.disconnected_at ? new Date(row.disconnected_at) : null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  } satisfies ConnectorInstanceProps);
}

export class PgConnectorInstanceRepository implements IConnectorInstanceRepository {
  constructor(private readonly pool: DbPool) {}

  async findByBrandAndProvider(
    brandId: string,
    provider: 'shopify',
  ): Promise<ConnectorInstance | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `SELECT id, brand_id, provider, shop_domain, secret_ref, status,
                connected_at, disconnected_at, created_at, updated_at
         FROM connector_instance
         WHERE brand_id = $1 AND provider = $2`,
        [brandId, provider],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async findById(id: string, brandId: string): Promise<ConnectorInstance | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `SELECT id, brand_id, provider, shop_domain, secret_ref, status,
                connected_at, disconnected_at, created_at, updated_at
         FROM connector_instance
         WHERE id = $1 AND brand_id = $2`,
        [id, brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async save(instance: ConnectorInstance): Promise<ConnectorInstance> {
    const ctx: QueryContext = { brandId: instance.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `INSERT INTO connector_instance
           (id, brand_id, provider, shop_domain, secret_ref, status,
            connected_at, disconnected_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, brand_id, provider, shop_domain, secret_ref, status,
                   connected_at, disconnected_at, created_at, updated_at`,
        [
          instance.id,
          instance.brandId,
          instance.provider,
          instance.shopDomain,
          instance.secretRef,
          instance.status,
          instance.connectedAt.toISOString(),
          instance.disconnectedAt?.toISOString() ?? null,
          instance.createdAt.toISOString(),
          instance.updatedAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorInstanceRepository] INSERT returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  async update(instance: ConnectorInstance): Promise<ConnectorInstance> {
    const ctx: QueryContext = { brandId: instance.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<ConnectorInstanceRow>(
        ctx,
        `UPDATE connector_instance
         SET status = $1, disconnected_at = $2, updated_at = $3
         WHERE id = $4 AND brand_id = $5
         RETURNING id, brand_id, provider, shop_domain, secret_ref, status,
                   connected_at, disconnected_at, created_at, updated_at`,
        [
          instance.status,
          instance.disconnectedAt?.toISOString() ?? null,
          instance.updatedAt.toISOString(),
          instance.id,
          instance.brandId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgConnectorInstanceRepository] UPDATE returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }
}
