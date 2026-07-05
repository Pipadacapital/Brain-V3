/**
 * pending-window flush handler — the server-side 09:00-IST release of queued sends.
 *
 * A send blocked ONLY by the 9–9 IST window is queued as a send_log row with
 * status='pending_window' + release_after. This handler (an in-service scheduled
 * handler — NOT a new deployable, I-E05) runs at/after 09:00 IST and, for each due
 * row, RE-EVALUATES canContact. This is load-bearing: a consent WITHDRAWAL between
 * queue-time and flush-time MUST suppress the send (COMPLIANCE.md) — so we never
 * blindly flush a queued row, we re-run the full gate.
 *
 * Outcomes per row:
 *   - allow                → mark 'released' (the channel send proceeds downstream).
 *   - block                → mark 'blocked' with the new reason (withdrawal suppressed it).
 *   - queue_pending_window → still out of window (clock edge); leave queued, bump release_after.
 *
 * The handler NEVER sends out-of-window and NEVER drops a row — every queued row ends
 * in a terminal released/blocked state or stays queued for the next window.
 */

import type { DbClient, QueryContext } from '@brain/db';
import type { CanContactEngine } from './compliance/can-contact.engine.js';
import type { ContactChannel, ContactPurpose } from './compliance/contact-types.js';

export interface PendingWindowRow {
  id: string;
  brandId: string;
  subjectHash: string;
  channel: ContactChannel;
  notificationType: string;
  releaseAfter: string;
}

export interface PendingWindowFlushDeps {
  db: DbClient;
  engine: CanContactEngine;
  /**
   * Resolve the raw recipient for a queued subject_hash so the gate can re-hash +
   * re-check. The chokepoint stores only the hash; flushing requires the address
   * from the send_service-role PII vault (never persisted in send_log). In dev this
   * may be a fixture map. Returning null => the row is left queued (cannot re-check
   * safely → fail-closed, never flush blind).
   */
  resolveRecipient: (row: PendingWindowRow) => Promise<string | null>;
  now?: () => Date;
}

export interface FlushResult {
  scanned: number;
  released: number;
  blocked: number;
  stillQueued: number;
}

/**
 * @public AUD-CODE-003 (open audit item): the deferred DND-window flush seam. The queue side is
 * LIVE (can-contact.engine emits `queue_pending_window`; send-log persists status='pending_window');
 * this handler awaits its scheduler wiring — deleting it would orphan the live queue path.
 */
export class PendingWindowFlushHandler {
  constructor(private readonly deps: PendingWindowFlushDeps) {}

  /**
   * Flush all pending_window rows whose release_after has passed, for a brand.
   * Returns a tally for observability / the gate-activity UI.
   */
  async flushBrand(brandId: string, correlationId: string): Promise<FlushResult> {
    const now = this.deps.now ? this.deps.now() : new Date();
    const ctx: QueryContext = { brandId, correlationId };

    const due = await this.deps.db.query<{
      id: string;
      subject_hash: string;
      channel: ContactChannel;
      notification_type: string;
      release_after: string;
    }>(
      ctx,
      `SELECT id, subject_hash, channel, notification_type, release_after
         FROM send_log
        WHERE brand_id = $1
          AND status = 'pending_window'
          AND release_after IS NOT NULL
          AND release_after <= $2
        ORDER BY release_after ASC
        LIMIT 500`,
      [brandId, now.toISOString()],
    );

    const result: FlushResult = {
      scanned: due.rows.length,
      released: 0,
      blocked: 0,
      stillQueued: 0,
    };

    for (const row of due.rows) {
      const pwRow: PendingWindowRow = {
        id: row.id,
        brandId,
        subjectHash: row.subject_hash,
        channel: row.channel,
        notificationType: row.notification_type,
        releaseAfter: row.release_after,
      };

      const recipient = await this.deps.resolveRecipient(pwRow);
      if (recipient === null) {
        // Cannot re-check safely → leave queued (fail-closed; never flush blind).
        result.stillQueued += 1;
        continue;
      }

      // Re-run the FULL gate — a mid-queue withdrawal/tombstone now suppresses.
      const purpose: ContactPurpose = 'marketing';
      const decision = await this.deps.engine.evaluate({
        brandId,
        recipient,
        channel: row.channel,
        purpose,
      });

      if (decision.decision === 'allow') {
        await this.markStatus(ctx, brandId, row.id, 'released', null, null);
        result.released += 1;
      } else if (decision.decision === 'block') {
        await this.markStatus(ctx, brandId, row.id, 'blocked', decision.reason, null);
        result.blocked += 1;
      } else {
        // queue_pending_window again (clock edge) — bump release_after, never send late.
        await this.markStatus(
          ctx,
          brandId,
          row.id,
          'pending_window',
          null,
          decision.releaseAfter ?? null,
        );
        result.stillQueued += 1;
      }
    }

    return result;
  }

  private async markStatus(
    ctx: QueryContext,
    brandId: string,
    id: string,
    status: 'released' | 'blocked' | 'pending_window',
    blockedReason: string | null,
    releaseAfter: string | null,
  ): Promise<void> {
    await this.deps.db.query(
      ctx,
      `UPDATE send_log
          SET status = $3,
              blocked_reason = $4,
              release_after = $5
        WHERE brand_id = $1 AND id = $2`,
      [brandId, id, status, blockedReason, releaseAfter],
    );
  }
}
