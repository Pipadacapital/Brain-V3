/**
 * PgPixelInstallationRepository — Postgres-backed repository for pixel_installation.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { IPixelInstallationRepository } from '../../domain/repositories/IPixelInstallationRepository.js';
import { PixelInstallation } from '../../domain/entities/PixelInstallation.js';

interface PixelInstallationRow {
  id: string;
  brand_id: string;
  install_token: string;
  target_host: string;
  installed_at: Date | null;
  custom_ingest_host: string | null;
  created_at: Date;
  updated_at: Date;
}

// Column list shared by every read — keeps custom_ingest_host in all SELECT/RETURNING projections.
const COLS = `id, brand_id, install_token, target_host, installed_at, custom_ingest_host, created_at, updated_at`;

function rowToEntity(row: PixelInstallationRow): PixelInstallation {
  return PixelInstallation.create({
    id: row.id,
    brandId: row.brand_id,
    installToken: row.install_token,
    targetHost: row.target_host,
    installedAt: row.installed_at ? new Date(row.installed_at) : null,
    customIngestHost: row.custom_ingest_host ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  });
}

export class PgPixelInstallationRepository implements IPixelInstallationRepository {
  constructor(private readonly pool: DbPool) {}

  async findByBrandId(brandId: string): Promise<PixelInstallation | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelInstallationRow>(
        ctx,
        `SELECT ${COLS}
         FROM pixel_installation
         WHERE brand_id = $1`,
        [brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async findById(id: string, brandId: string): Promise<PixelInstallation | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelInstallationRow>(
        ctx,
        `SELECT ${COLS}
         FROM pixel_installation
         WHERE id = $1 AND brand_id = $2`,
        [id, brandId],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async save(installation: PixelInstallation): Promise<PixelInstallation> {
    const ctx: QueryContext = { brandId: installation.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelInstallationRow>(
        ctx,
        `INSERT INTO pixel_installation
           (id, brand_id, install_token, target_host, installed_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLS}`,
        [
          installation.id,
          installation.brandId,
          installation.installToken,
          installation.targetHost,
          installation.installedAt?.toISOString() ?? null,
          installation.createdAt.toISOString(),
          installation.updatedAt.toISOString(),
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgPixelInstallationRepository] INSERT returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  async update(installation: PixelInstallation): Promise<PixelInstallation> {
    const ctx: QueryContext = { brandId: installation.brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelInstallationRow>(
        ctx,
        `UPDATE pixel_installation
         SET installed_at = $1, updated_at = $2, target_host = $3
         WHERE id = $4 AND brand_id = $5
         RETURNING ${COLS}`,
        [
          installation.installedAt?.toISOString() ?? null,
          installation.updatedAt.toISOString(),
          installation.targetHost,
          installation.id,
          installation.brandId,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error('[PgPixelInstallationRepository] UPDATE returned no row');
      return rowToEntity(row);
    } finally {
      client.release();
    }
  }

  async setCustomIngestHost(brandId: string, host: string | null): Promise<PixelInstallation | null> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      const result = await client.query<PixelInstallationRow>(
        ctx,
        `UPDATE pixel_installation
         SET custom_ingest_host = $2, updated_at = now()
         WHERE brand_id = $1
         RETURNING ${COLS}`,
        [brandId, host],
      );
      const row = result.rows[0];
      return row ? rowToEntity(row) : null;
    } finally {
      client.release();
    }
  }

  async markAutoInstalled(brandId: string, provider: string, ref: string): Promise<void> {
    const ctx: QueryContext = { brandId, correlationId: 'n/a' };
    const client = await this.pool.connect();
    try {
      // COALESCE keeps the original installed_at on a re-install (idempotent); records the
      // provider + handle so the install is uninstallable and re-runs detect "already done".
      await client.query(
        ctx,
        `UPDATE pixel_installation
         SET installed_at = COALESCE(installed_at, now()), updated_at = now(),
             auto_install_provider = $2, auto_install_ref = $3
         WHERE brand_id = $1`,
        [brandId, provider, ref],
      );
    } finally {
      client.release();
    }
  }
}
