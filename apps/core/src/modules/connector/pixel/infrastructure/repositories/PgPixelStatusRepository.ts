/**
 * PgPixelStatusRepository — Postgres-backed repository for pixel_status.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { IPixelStatusRepository } from '../../domain/repositories/IPixelStatusRepository.js';
import { PixelStatus } from '../../domain/entities/PixelStatus.js';
import type { PixelState } from '../../domain/entities/PixelStatus.js';

interface PixelStatusRow {
  id: string;
  brand_id: string;
  pixel_installation_id: string;
  state: PixelState;
  verified_at: Date | null;
  last_error: string | null;
  updated_at: Date;
}

function rowToEntity(row: PixelStatusRow): PixelStatus {
  return PixelStatus.create({
    id: row.id,
    brandId: row.brand_id,
    pixelInstallationId: row.pixel_installation_id,
    state: row.state,
    verifiedAt: row.verified_at ? new Date(row.verified_at) : null,
    lastError: row.last_error,
    updatedAt: new Date(row.updated_at),
  });
}

export class PgPixelStatusRepository implements IPixelStatusRepository {
  constructor(private readonly pool: DbPool) {}

  async findByInstallationId(
    pixelInstallationId: string,
    brandId: string,
  ): Promise<PixelStatus | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelStatusRow>(
        ctx,
        `SELECT id, brand_id, pixel_installation_id, state, verified_at, last_error, updated_at
         FROM pixel_status
         WHERE pixel_installation_id = $1 AND brand_id = $2`,
        [pixelInstallationId, brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async findByBrandId(brandId: string): Promise<PixelStatus | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelStatusRow>(
        ctx,
        `SELECT ps.id, ps.brand_id, ps.pixel_installation_id, ps.state,
                ps.verified_at, ps.last_error, ps.updated_at
         FROM pixel_status ps
         WHERE ps.brand_id = $1
         ORDER BY ps.updated_at DESC
         LIMIT 1`,
        [brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async save(status: PixelStatus): Promise<PixelStatus> {
    const ctx: QueryContext = { brandId: status.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelStatusRow>(
        ctx,
        `INSERT INTO pixel_status
           (id, brand_id, pixel_installation_id, state, verified_at, last_error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, brand_id, pixel_installation_id, state, verified_at, last_error, updated_at`,
        [
          status.id,
          status.brandId,
          status.pixelInstallationId,
          status.state,
          status.verifiedAt?.toISOString() ?? null,
          status.lastError,
          status.updatedAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgPixelStatusRepository] INSERT returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  async update(status: PixelStatus): Promise<PixelStatus> {
    const ctx: QueryContext = { brandId: status.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelStatusRow>(
        ctx,
        `UPDATE pixel_status
         SET state = $1, verified_at = $2, last_error = $3, updated_at = $4
         WHERE id = $5 AND brand_id = $6
         RETURNING id, brand_id, pixel_installation_id, state, verified_at, last_error, updated_at`,
        [
          status.state,
          status.verifiedAt?.toISOString() ?? null,
          status.lastError,
          status.updatedAt.toISOString(),
          status.id,
          status.brandId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgPixelStatusRepository] UPDATE returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }
}
