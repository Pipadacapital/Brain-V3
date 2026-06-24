/**
 * workspace-access infrastructure — Brand Postgres repository.
 *
 * RLS: app.current_brand_id — set via ctx.brandId.
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import { randomUUID } from 'node:crypto';
import type { DbClient, QueryContext } from '@brain/db';
import type { Brand, CurrencyCode, BrandTimezone, RevenueDefinition } from '../../domain/brand/entities.js';
import { encodeCursor, decodeCursor } from './shared.js';

// ── Brand Repository ──────────────────────────────────────────────────────────
// RLS: app.current_brand_id — set via ctx.brandId.

export class BrandRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      organizationId: string;
      displayName: string;
      domain?: string | null;
      regionCode?: string;
      currencyCode?: CurrencyCode;
      timezone?: BrandTimezone;
      revenueDefinition?: RevenueDefinition;
    },
    ctx: QueryContext,
  ): Promise<Brand> {
    // Generate the brand id app-side and set it as the brand GUC for THIS insert: the brand_isolation
    // RLS policy gates INSERT with `id = current_setting('app.current_brand_id')::uuid`, so the row
    // can only be written when the brand GUC equals the new id. (Letting the DB default the id —
    // with no brand GUC set — makes the WITH CHECK unsatisfiable under brain_app, a 42501.)
    const id = randomUUID();
    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      { ...ctx, brandId: id },
      `INSERT INTO brand (id, organization_id, display_name, domain, region_code, currency_code, timezone, revenue_definition)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at`,
      [
        id,
        data.organizationId, data.displayName, data.domain ?? null,
        data.regionCode ?? 'IN',
        data.currencyCode ?? 'INR',
        data.timezone ?? 'Asia/Kolkata',
        data.revenueDefinition ?? 'realized',
      ],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findById(id: string, ctx: QueryContext): Promise<Brand | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at
       FROM brand WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async findByOrganizationId(
    organizationId: string,
    cursor: string | undefined,
    limit: number,
    ctx: QueryContext,
  ): Promise<{ items: Brand[]; nextCursor: string | null; hasMore: boolean }> {
    const cursorId = cursor ? decodeCursor(cursor) : null;

    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at
       FROM brand
       WHERE organization_id = $1
         ${cursorId ? 'AND id > $3' : ''}
       ORDER BY id ASC
       LIMIT $2`,
      cursorId ? [organizationId, limit + 1, cursorId] : [organizationId, limit + 1],
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((r) => this.mapRow(r));
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.id) : null;

    return { items, nextCursor, hasMore };
  }

  async update(
    id: string,
    data: {
      displayName?: string;
      domain?: string | null;
      status?: 'active' | 'archived';
      currencyCode?: CurrencyCode;
      timezone?: BrandTimezone;
      revenueDefinition?: RevenueDefinition;
    },
    ctx: QueryContext,
  ): Promise<Brand | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; display_name: string;
      domain: string | null; status: string; region_code: string;
      currency_code: string | null; timezone: string | null; revenue_definition: string | null;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `UPDATE brand SET
         display_name = COALESCE($1, display_name),
         domain = CASE WHEN $2::boolean THEN $3 ELSE domain END,
         status = COALESCE($4, status),
         currency_code = COALESCE($5, currency_code),
         timezone = COALESCE($6, timezone),
         revenue_definition = COALESCE($7, revenue_definition),
         updated_at = NOW()
       WHERE id = $8
       RETURNING id, organization_id, display_name, domain, status, region_code, currency_code, timezone, revenue_definition, created_at, updated_at`,
      [
        data.displayName ?? null,
        'domain' in data ? true : false,
        data.domain ?? null,
        data.status ?? null,
        data.currencyCode ?? null,
        data.timezone ?? null,
        data.revenueDefinition ?? null,
        id,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: {
    id: string; organization_id: string; display_name: string;
    domain: string | null; status: string; region_code: string;
    currency_code?: string | null; timezone?: string | null; revenue_definition?: string | null;
    created_at: Date; updated_at: Date;
  }): Brand {
    return {
      id: row.id,
      organizationId: row.organization_id,
      displayName: row.display_name,
      domain: row.domain,
      status: row.status as 'active' | 'archived',
      regionCode: row.region_code,
      // MA-08: column-absent defensive ?? fallback for deploy-window race (migrate → core → web).
      currencyCode: (row.currency_code ?? 'INR') as CurrencyCode,
      timezone: (row.timezone ?? 'Asia/Kolkata') as BrandTimezone,
      revenueDefinition: (row.revenue_definition ?? 'realized') as RevenueDefinition,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
