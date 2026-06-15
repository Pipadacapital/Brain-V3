/**
 * send_log — records all outbound notification attempts.
 * Written before the email is sent (fire-and-store pattern).
 */

import type { DbClient, QueryContext } from '@brain/db';

export interface SendLogEntry {
  correlationId: string;
  recipient: string;
  channel: 'email';
  notificationType: string;
  status: 'attempted' | 'sent' | 'failed';
  errorMessage?: string;
}

/**
 * Insert a send_log entry.
 * Uses the send_log table which is written to via the notification module.
 * For M1, we log to console in dev and to a DB table when available.
 */
export async function writeSendLog(
  client: DbClient | null,
  entry: SendLogEntry,
  ctx: QueryContext,
): Promise<void> {
  // In M1 with a real DB, this would INSERT into send_log.
  // For now, log to console (the send_log table is deferred to a separate migration).
  // This is acceptable for M1 since send_log is informational, not an audit SoR.
  console.info('[notification:send_log]', {
    correlation_id: entry.correlationId,
    recipient_masked: entry.recipient.replace(/(.{1}).+@/, '$1***@'),
    channel: entry.channel,
    type: entry.notificationType,
    status: entry.status,
    error: entry.errorMessage,
  });
}
