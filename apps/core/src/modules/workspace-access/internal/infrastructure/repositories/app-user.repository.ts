/**
 * workspace-access infrastructure — AppUser Postgres repository.
 *
 * NO RLS on app_user — service-layer isolation via explicit WHERE clauses.
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { AppUser } from '../../domain/auth/entities.js';

// ── App User Repository ───────────────────────────────────────────────────────
// NO RLS on app_user — service-layer isolation via explicit WHERE clauses.

export class AppUserRepository {
  constructor(private readonly db: DbClient) {}

  /** Find by email (case-insensitive via citext). Service-layer isolation: no GUC needed. */
  async findByEmail(
    email: string,
    ctx: QueryContext,
  ): Promise<AppUser | null> {
    const result = await this.db.query<{
      id: string; email: string; email_normalized: string;
      password_hash: string; email_verified_at: Date | null;
      status: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, email, email_normalized, password_hash, email_verified_at, status, created_at, updated_at
       FROM app_user
       WHERE email = $1`,
      [email],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  /** Find by id. Service-layer isolation: explicit WHERE id = $1. */
  async findById(id: string, ctx: QueryContext): Promise<AppUser | null> {
    const result = await this.db.query<{
      id: string; email: string; email_normalized: string;
      password_hash: string; email_verified_at: Date | null;
      status: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `SELECT id, email, email_normalized, password_hash, email_verified_at, status, created_at, updated_at
       FROM app_user
       WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async insert(
    data: { email: string; emailNormalized: string; passwordHash: string },
    ctx: QueryContext,
  ): Promise<AppUser> {
    const result = await this.db.query<{
      id: string; email: string; email_normalized: string;
      password_hash: string; email_verified_at: Date | null;
      status: string; created_at: Date; updated_at: Date;
    }>(
      ctx,
      `INSERT INTO app_user (email, email_normalized, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, email, email_normalized, password_hash, email_verified_at, status, created_at, updated_at`,
      [data.email, data.emailNormalized, data.passwordHash],
    );
    return this.mapRow(result.rows[0]!);
  }

  async markEmailVerified(id: string, verifiedAt: Date, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE app_user SET email_verified_at = $1, updated_at = NOW() WHERE id = $2`,
      [verifiedAt, id],
    );
  }

  async updatePasswordHash(id: string, passwordHash: string, ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE app_user SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passwordHash, id],
    );
  }

  async updateStatus(id: string, status: 'active' | 'suspended', ctx: QueryContext): Promise<void> {
    await this.db.query(
      ctx,
      `UPDATE app_user SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id],
    );
  }

  /** Find pending invite for a given email (used by register flow AC-7). */
  async findPendingInviteByEmail(email: string, ctx: QueryContext): Promise<{ id: string } | null> {
    const result = await this.db.query<{ id: string }>(
      ctx,
      `SELECT id FROM invite WHERE email = $1 AND status = 'pending' AND expires_at > NOW() LIMIT 1`,
      [email.toLowerCase()],
    );
    return result.rows[0] ?? null;
  }

  private mapRow(row: {
    id: string; email: string; email_normalized: string;
    password_hash: string; email_verified_at: Date | null;
    status: string; created_at: Date; updated_at: Date;
  }): AppUser {
    return {
      id: row.id,
      email: row.email,
      emailNormalized: row.email_normalized,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at,
      status: row.status as 'active' | 'suspended',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
