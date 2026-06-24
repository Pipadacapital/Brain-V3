/**
 * workspace-access infrastructure — EmailVerification Postgres repository.
 *
 * RLS: app.current_user_id.
 * All queries use the 3-GUC QueryContext (NN-1).
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { EmailVerificationToken } from '../../domain/auth/entities.js';

// ── Email Verification Repository ─────────────────────────────────────────────
// RLS: app.current_user_id.

export class EmailVerificationRepository {
  constructor(private readonly db: DbClient) {}

  async insert(
    data: { appUserId: string; tokenHash: string; expiresAt: Date },
    ctx: QueryContext,
  ): Promise<EmailVerificationToken> {
    const result = await this.db.query<{
      id: string; app_user_id: string; token_hash: string;
      expires_at: Date; used_at: Date | null; created_at: Date;
    }>(
      ctx,
      `INSERT INTO email_verification (app_user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING id, app_user_id, token_hash, expires_at, used_at, created_at`,
      [data.appUserId, data.tokenHash, data.expiresAt],
    );
    return this.mapRow(result.rows[0]!);
  }

  async findValidByHash(tokenHash: string, ctx: QueryContext): Promise<EmailVerificationToken | null> {
    const result = await this.db.query<{
      id: string; app_user_id: string; token_hash: string;
      expires_at: Date; used_at: Date | null; created_at: Date;
    }>(
      ctx,
      `SELECT id, app_user_id, token_hash, expires_at, used_at, created_at
       FROM email_verification
       WHERE token_hash = $1
         AND used_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;
    return this.mapRow(row);
  }

  async markUsed(id: string, ctx: QueryContext): Promise<void> {
    await this.db.query(ctx, `UPDATE email_verification SET used_at = NOW() WHERE id = $1`, [id]);
  }

  private mapRow(row: {
    id: string; app_user_id: string; token_hash: string;
    expires_at: Date; used_at: Date | null; created_at: Date;
  }): EmailVerificationToken {
    return {
      id: row.id,
      appUserId: row.app_user_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      createdAt: row.created_at,
    };
  }
}
