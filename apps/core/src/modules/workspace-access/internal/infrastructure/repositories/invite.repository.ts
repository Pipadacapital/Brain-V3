/**
 * workspace-access infrastructure — Invite Postgres repository.
 *
 * RLS: compound NN-7 (two PERMISSIVE policies for nullable brand_id).
 * GUC: ctx.workspaceId (for org-level) + ctx.brandId (for brand-level).
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { Invite, InviteStatus } from '../../domain/invite/entities.js';
import type { RoleCode } from '../../domain/membership/entities.js';
import { encodeCursor, decodeCursor } from './shared.js';

// ── Invite Repository ─────────────────────────────────────────────────────────
// RLS: compound NN-7 (two PERMISSIVE policies for nullable brand_id).
// GUC: ctx.workspaceId (for org-level) + ctx.brandId (for brand-level).

export class InviteRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: {
      organizationId: string;
      brandId: string | null;
      email: string;
      roleCode: RoleCode;
      tokenHash: string;
      invitedByUserId: string;
      expiresAt: Date;
    },
    ctx: QueryContext,
  ): Promise<Invite> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `INSERT INTO invite (organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at`,
      [
        data.organizationId, data.brandId, data.email, data.roleCode,
        data.tokenHash, data.invitedByUserId, data.expiresAt,
      ],
    );
    return this.mapRow(result.rows[0]!);
  }

  /** Find a valid (pending, non-expired) invite by token hash. */
  async findValidByHash(tokenHash: string, ctx: QueryContext): Promise<Invite | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at
       FROM invite
       WHERE token_hash = $1
         AND status = 'pending'
         AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async markAccepted(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE invite SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async updateStatus(id: string, status: InviteStatus, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE invite SET status = $1 WHERE id = $2`,
      [status, id],
    );
  }

  /**
   * D-3: Rotate token on resend — update token_hash + expires_at on the existing pending row.
   * No second row created. Uses GUC pool (RLS-enforced by caller's ctx).
   */
  async rotateToken(
    id: string,
    tokenHash: string,
    expiresAt: Date,
    ctx: QueryContext,
  ): Promise<Invite | null> {
    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `UPDATE invite SET token_hash = $1, expires_at = $2
       WHERE id = $3 AND status = 'pending'
       RETURNING id, organization_id, brand_id, email, role_code, token_hash, invited_by_user_id, status, expires_at, accepted_at, created_at`,
      [tokenHash, expiresAt, id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /**
   * D-4: List pending invites with actor-role-based predicate.
   * - owner: all pending in org (RLS scopes to org; no extra predicate).
   * - brand_admin: all pending in brand scope (RLS GUCs handle it).
   * - manager/analyst: only invites they created (AND invited_by_user_id = $actor).
   * RLS provides isolation underneath (workspaceId + brandId GUCs via ctx).
   *
   * Uses fully-parameterized queries; no string interpolation of user-supplied values.
   */
  async listPending(
    organizationId: string,
    brandId: string | null,
    actorRole: string,
    actorUserId: string,
    cursor: string | undefined,
    limit: number,
    ctx: QueryContext,
  ): Promise<{ items: Invite[]; nextCursor: string | null; hasMore: boolean }> {
    const cursorId = cursor ? decodeCursor(cursor) : null;

    // Build params array dynamically to keep all user-data fully parameterized.
    // $1 = organizationId, $2 = limit + 1, then optional $3+ for brandId/actorUserId/cursorId.
    const params: unknown[] = [organizationId, limit + 1];
    let paramIdx = 3;

    // D-4: Owner sees ALL pending invites in the org (both org-level brand_id=NULL and
    // brand-level invites). brandId filter is applied for brand_admin (brand-scoped) and
    // is removed entirely for owner so org-level invites (brand_id=NULL) are visible even
    // when the owner's session carries a non-null brandId context.
    let brandClause: string;
    if (actorRole === 'owner') {
      // Owner: no brand filter — returns all pending invites for the org.
      brandClause = '';
    } else if (brandId) {
      brandClause = `AND i.brand_id = $${paramIdx++}`;
      params.push(brandId);
    } else {
      brandClause = `AND i.brand_id IS NULL`;
    }

    let actorClause = '';
    if (actorRole === 'manager' || actorRole === 'analyst') {
      actorClause = `AND i.invited_by_user_id = $${paramIdx++}`;
      params.push(actorUserId);
    }

    let cursorClause = '';
    if (cursorId) {
      cursorClause = `AND i.id > $${paramIdx++}`;
      params.push(cursorId);
    }

    const result = await this.db.query<{
      id: string; organization_id: string; brand_id: string | null;
      email: string; role_code: string; token_hash: string;
      invited_by_user_id: string; status: string;
      expires_at: Date; accepted_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT i.id, i.organization_id, i.brand_id, i.email, i.role_code, i.token_hash,
              i.invited_by_user_id, i.status, i.expires_at, i.accepted_at, i.created_at
       FROM invite i
       WHERE i.organization_id = $1
         AND i.status = 'pending'
         AND i.expires_at > NOW()
         ${brandClause}
         ${actorClause}
         ${cursorClause}
       ORDER BY i.id ASC
       LIMIT $2`,
      params,
    );

    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit).map((r) => this.mapRow(r));
    const lastItem = items[items.length - 1];
    const nextCursor = hasMore && lastItem ? encodeCursor(lastItem.id) : null;
    return { items, nextCursor, hasMore };
  }

  private mapRow(row: {
    id: string; organization_id: string; brand_id: string | null;
    email: string; role_code: string; token_hash: string;
    invited_by_user_id: string; status: string;
    expires_at: Date; accepted_at: Date | null; created_at: Date;
  }): Invite {
    return {
      id: row.id,
      organizationId: row.organization_id,
      brandId: row.brand_id,
      email: row.email,
      roleCode: row.role_code as RoleCode,
      tokenHash: row.token_hash,
      invitedByUserId: row.invited_by_user_id,
      status: row.status as InviteStatus,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      createdAt: row.created_at,
    };
  }
}
