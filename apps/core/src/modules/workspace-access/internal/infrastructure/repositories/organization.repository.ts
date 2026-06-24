/**
 * workspace-access infrastructure — Organization Postgres repository.
 *
 * RLS: app.current_workspace_id — set via ctx.workspaceId.
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { Organization, OnboardingStatus } from '../../domain/organization/entities.js';

// ── Organization Repository ───────────────────────────────────────────────────
// RLS: app.current_workspace_id — set via ctx.workspaceId.

export class OrganizationRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: { name: string; slug: string; ownerUserId: string; regionCode?: string },
    ctx: QueryContext,
  ): Promise<Organization> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO organization (name, slug, owner_user_id, region_code)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at`,
      [data.name, data.slug, data.ownerUserId, data.regionCode ?? 'IN'],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findById(id: string, ctx: QueryContext): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at
       FROM organization WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async findBySlug(slug: string, ctx: QueryContext): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at
       FROM organization WHERE slug = $1`,
      [slug],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /** List all workspaces a user is a member of (cross-workspace, no RLS needed for membership lookup). */
  async findByUserId(userId: string, ctx: QueryContext): Promise<Organization[]> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT o.id, o.name, o.slug, o.owner_user_id, o.region_code, o.onboarding_status, o.onboarding_step, o.created_at, o.updated_at
       FROM organization o
       INNER JOIN membership m ON m.organization_id = o.id
       WHERE m.app_user_id = $1 AND m.brand_id IS NULL
       ORDER BY o.created_at DESC`,
      [userId],
    );
    return result.rows.map((r) => this.mapRow(r));
  }

  async update(
    id: string,
    data: { name?: string },
    ctx: QueryContext,
  ): Promise<Organization | null> {
    const result = await this.db.query<{
      id: string; name: string; slug: string;
      owner_user_id: string; region_code: string;
      onboarding_status: string; onboarding_step: number;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `UPDATE organization SET name = COALESCE($1, name), updated_at = NOW()
       WHERE id = $2
       RETURNING id, name, slug, owner_user_id, region_code, onboarding_status, onboarding_step, created_at, updated_at`,
      [data.name ?? null, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Advance onboarding_status + onboarding_step forward-only (idempotent guard).
   * Only advances if the current step is less than the target step.
   * MA-09: M1 tracks first-brand onboarding only.
   */
  async advanceOnboardingStatus(
    orgId: string,
    newStatus: OnboardingStatus,
    newStep: number,
    ctx: QueryContext,
  ): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE organization
       SET onboarding_status = $1, onboarding_step = $2, updated_at = NOW()
       WHERE id = $3 AND onboarding_step < $2`,
      [newStatus, newStep, orgId],
    );
  }

  private mapRow(row: {
    id: string; name: string; slug: string;
    owner_user_id: string; region_code: string;
    onboarding_status?: string; onboarding_step?: number;
    created_at: Date; updated_at: Date;
  }): Organization {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      ownerUserId: row.owner_user_id,
      regionCode: row.region_code,
      // MA-08: column-absent defensive fallback (deploy order: migrate → core → web)
      onboardingStatus: (row.onboarding_status ?? 'pending') as OnboardingStatus,
      onboardingStep: row.onboarding_step ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
