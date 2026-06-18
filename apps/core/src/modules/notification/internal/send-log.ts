/**
 * send_log — records all outbound notification attempts AND gate decisions.
 *
 * D13: extended to carry the can_contact() gate outcome. Every row stores a HASHED
 * subject (subject_hash) — raw email/phone is NEVER written to a column or a log
 * (I-S02). The legacy `recipient` field on SendLogEntry is masked at the boundary
 * and, when a salt-hashing path is available, replaced by subject_hash.
 *
 * New statuses:
 *   - 'blocked'         — the gate blocked the send (blockedReason set).
 *   - 'pending_window'  — out-of-window; queued, releaseAfter set; flushed at 09:00 IST.
 *
 * When a DbClient is supplied, a real INSERT into send_log is performed (additive
 * table from migration 0032). Without a client the entry is logged (dev) — the same
 * fire-and-store discipline as before, never blocking the send path.
 */

import type { DbClient, QueryContext } from '@brain/db';

export type SendLogStatus =
  | 'attempted'
  | 'sent'
  | 'failed'
  | 'blocked'
  | 'pending_window';

export interface SendLogEntry {
  correlationId: string;
  /**
   * Legacy raw recipient (transactional callers). Masked before logging; when a
   * subjectHash is provided it is preferred and the raw value is never persisted.
   */
  recipient?: string;
  /** Hashed subject (identity-core). Preferred over `recipient` for persistence. */
  subjectHash?: string;
  channel: 'email' | 'marketing_email' | 'whatsapp' | 'sms' | 'transactional_email';
  notificationType: string;
  status: SendLogStatus;
  errorMessage?: string;
  /** can_contact() block reason, when status === 'blocked'. */
  blockedReason?: string;
  /** ISO-8601 release instant, when status === 'pending_window'. */
  releaseAfter?: string;
  /** Optional brand scope for the DB INSERT (RLS GUC). */
  brandId?: string;
}

function maskRecipient(recipient: string): string {
  return recipient.replace(/(.{1}).+@/, '$1***@');
}

/**
 * Insert a send_log entry.
 *
 * If `client` and `entry.brandId` are provided, INSERTs into the send_log table
 * (subject_hash, status, blocked_reason, release_after) — never the raw recipient.
 * Otherwise logs a masked line (dev / no-DB path). Errors here NEVER propagate to
 * the caller (informational store, not a send blocker).
 */
export async function writeSendLog(
  client: DbClient | null,
  entry: SendLogEntry,
  ctx: QueryContext,
): Promise<void> {
  // Always emit a masked structured log line (no raw PII).
  console.info('[notification:send_log]', {
    correlation_id: entry.correlationId,
    subject_hash: entry.subjectHash ?? null,
    recipient_masked: entry.recipient ? maskRecipient(entry.recipient) : null,
    channel: entry.channel,
    type: entry.notificationType,
    status: entry.status,
    blocked_reason: entry.blockedReason ?? null,
    release_after: entry.releaseAfter ?? null,
    error: entry.errorMessage,
  });

  // Real INSERT only when we have a DB client AND a brand scope AND a hashed
  // subject (we refuse to persist a raw recipient — I-S02).
  if (!client || !entry.brandId || !entry.subjectHash) return;

  try {
    const queryCtx: QueryContext = {
      ...ctx,
      brandId: entry.brandId,
      correlationId: entry.correlationId,
    };
    await client.query(
      queryCtx,
      `INSERT INTO send_log
         (brand_id, subject_hash, channel, notification_type, status,
          blocked_reason, release_after, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.brandId,
        entry.subjectHash,
        entry.channel,
        entry.notificationType,
        entry.status,
        entry.blockedReason ?? null,
        entry.releaseAfter ?? null,
        entry.correlationId,
      ],
    );
  } catch (err) {
    // Never block the send path on a send_log write failure.
    console.error('[notification:send_log] insert failed', {
      correlation_id: entry.correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
