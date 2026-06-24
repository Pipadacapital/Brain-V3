/**
 * workspace-access infrastructure — Membership Postgres repository.
 *
 * RLS: app.current_workspace_id.
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { Membership, RoleCode } from '../../domain/membership/entities.js';
import { encodeCursor, decodeCursor } from './shared.js';

// ── Membership Repository ─────────────────────────────────────────────────────
// RLS: app.current_workspace_id.

export class MembershipRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      organizationId: string;
      brandId: string | null;
      appUserId: string;
      roleCode: RoleCode;
    },
    ctx: QueryContext,
  ): Promise<Membership> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO membership (organization_id, brand_id, app_user_id, role_code)
       VALUES ($1, $2, $3, $4)
       RETURNING id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at`,
      [data.organizationId, data.brandId, data.appUserId, data.roleCode],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findByUserAndOrg(
    appUserId: string,
    organizationId: string,
    brandId: string | null,
    ctx: QueryContext,
  ): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      brandId
        ? `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
           FROM membership
           WHERE app_user_id = $1 AND organization_id = $2 AND brand_id = $3`
        : `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
           FROM membership
           WHERE app_user_id = $1 AND organization_id = $2 AND brand_id IS NULL`,
      brandId ? [appUserId, organizationId, brandId] : [appUserId, organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async listByOrganization(
    organizationId: string,
    brandId: string | undefined,
    cursor: string | undefined,
    limit: number,
    ctx: QueryContext,
  ): Promise<{ items: Array<Membership & { email: string; user_email: string; user_full_name: string; user_status: 'active' | 'suspended' }>; nextCursor: string | null; hasMore: boolean }> {
    const cursorId = cursor ? decodeCursor(cursor) : null;

    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; email: string; status: string;
      created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT m.id, m.organization_id, m.brand_id, m.app_user_id, m.role_code,
              u.email, u.status, m.created_at, m.updated_at
       FROM membership m
       INNER JOIN app_user u ON u.id = m.app_user_id
       WHERE m.organization_id = $1
         ${brandId ? 'AND m.brand_id = $3' : 'AND m.brand_id IS NULL'}
         ${cursorId ? `AND m.id > ${brandId ? '$4' : '$3'}` : ''}
       ORDER BY m.id ASC
       LIMIT $2`,
      [
        organizationId,
        limit + 1,
        ...(brandId ? [brandId] : []),
        ...(cursorId ? [cursorId] : []),
      ],
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((r) => ({
      ...this.mapRow(r),
      email: r.email,
      // Slice 3 / field-mismatch fix: user_email + user_full_name + user_status
      // for the members-table.tsx (reads user_email / user_full_name / user_status).
      // app_user has no separate name column → use email as placeholder (plan §3).
      user_email: r.email,
      user_full_name: r.email,
      user_status: (r.status as 'active' | 'suspended'),
    }));
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.id) : null;
    return { items, nextCursor, hasMore };
  }

  async countOwners(organizationId: string, ctx: QueryContext): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      ctx,
      `SELECT COUNT(*) AS count FROM membership
       WHERE organization_id = $1 AND role_code = 'owner' AND brand_id IS NULL`,
      [organizationId],
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  async updateRole(id: string, roleCode: RoleCode, ctx: QueryContext): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `UPDATE membership SET role_code = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at`,
      [roleCode, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async delete(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(ctx, `DELETE FROM membership WHERE id = $1`, [id]);
  }

  async findById(id: string, ctx: QueryContext): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
       FROM membership WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Resolve the user's "active" membership for session bootstrapping after login.
   * Reads the user's OWN membership rows via the membership_self_read RLS policy
   * (requires ctx.userId → app.current_user_id GUC; no workspace GUC needed).
   * Prefers a brand-level membership (brand_id NOT NULL) over an org-level one,
   * most recent first — so a fully-onboarded user resolves to {brand, role}.
   */
  async findActiveByUser(appUserId: string, ctx: QueryContext): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
       FROM membership
       WHERE app_user_id = $1
       ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC
       LIMIT 1`,
      [appUserId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * Resolve the user's "active" membership WITHIN a specific organization, for
   * session bootstrapping when a preferred workspace is known. Like
   * findActiveByUser, but org-scoped: prefers a brand-level membership
   * (brand_id NOT NULL) over the org-level one, most recent first — so a
   * fully-onboarded user staying in their workspace resolves to {brand, role}
   * instead of the brand-less org membership (which would mint brand_id=null and
   * break every brand-scoped surface).
   */
  async findActiveByUserAndOrg(
    appUserId: string,
    organizationId: string,
    ctx: QueryContext,
  ): Promise<Membership | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, app_user_id, role_code, created_at, updated_at
       FROM membership
       WHERE app_user_id = $1 AND organization_id = $2
       ORDER BY (brand_id IS NOT NULL) DESC, created_at DESC
       LIMIT 1`,
      [appUserId, organizationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  private mapRow(row: {
    id: string; organization_id: string; brand_id: string | null;
    app_user_id: string; role_code: string; created_at: Date; updated_at: Date;
  }): Membership {
    return {
      id: row.id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      appUserId: row.app_user_id,
      roleCode: row.role_code as RoleCode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
