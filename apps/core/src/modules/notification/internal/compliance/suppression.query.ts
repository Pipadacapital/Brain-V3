/**
 * PgSuppressionQuery — the consent suppression read seam, implemented against the
 * consent_record + consent_tombstone SoR (migration 0032), brand-GUC scoped.
 *
 * FAIL-CLOSED (D13 §13.4):
 *   suppressed = true when
 *     (a) a consent_tombstone covers (subject, category | NULL), OR
 *     (b) the LATEST consent_record for (subject, category) has state != 'granted', OR
 *     (c) NO consent_record row exists at all (default-closed: no consent = no send).
 *
 * The state is derived by query (no materialized table) so a just-committed tombstone
 * suppresses on the very next read (<15min SLA trivially met). Both tables are RLS
 * FORCE on app.current_brand_id; this query passes brandId via QueryContext so the
 * GUC is set before the SELECT (NN-1).
 *
 * PII: subjectHash is a 64-hex identity-core hash. Raw email/phone never enters here.
 */

import type { DbClient, QueryContext } from '@brain/db';
import type {
  SuppressionQuery,
  SuppressionResult,
  ConsentCategory,
} from '@brain/contracts';

export class PgSuppressionQuery implements SuppressionQuery {
  constructor(private readonly db: DbClient) {}

  async isSuppressed(args: {
    brandId: string;
    subjectHash: string;
    category: ConsentCategory;
  }): Promise<SuppressionResult> {
    const ctx: QueryContext = {
      brandId: args.brandId,
      correlationId: 'consent-suppression-read',
    };

    // (a) Tombstone existence — covers a specific category OR all (category IS NULL).
    // The brand GUC + RLS FORCE structurally scope this to the brand; the explicit
    // brand_id predicate is belt-and-suspenders + uses the lookup index.
    const tombstone = await this.db.query<{ exists: boolean }>(
      ctx,
      `SELECT EXISTS (
         SELECT 1 FROM consent_tombstone
         WHERE brand_id = $1
           AND subject_hash = $2
           AND (category IS NULL OR category = $3)
       ) AS exists`,
      [args.brandId, args.subjectHash, args.category],
    );
    if (tombstone.rows[0]?.exists) {
      return { suppressed: true, reason: 'tombstoned' };
    }

    // (b)/(c) Latest consent_record state for (subject, category).
    const latest = await this.db.query<{ state: string }>(
      ctx,
      `SELECT state
         FROM consent_record
        WHERE brand_id = $1
          AND subject_hash = $2
          AND category = $3
        ORDER BY effective_at DESC
        LIMIT 1`,
      [args.brandId, args.subjectHash, args.category],
    );

    const state = latest.rows[0]?.state;
    if (state === undefined) {
      // (c) No row at all → fail-closed default.
      return { suppressed: true, reason: 'no_consent' };
    }
    if (state !== 'granted') {
      // (b) Latest state is a withdrawal.
      return { suppressed: true, reason: 'withdrawn' };
    }
    return { suppressed: false, reason: null };
  }
}
