/**
 * merge-admin — identity merge/unmerge control-plane (P0-C).
 *
 * listMergeReviews: read the pending merge_review_queue for the active brand (RLS via @brain/db).
 * resolveMergeReview / unmergeCustomer: operator actions delegated to the SECURITY DEFINER
 * functions resolve_merge_review() / admin_unmerge_customer() (migration 0039). brandId is the
 * SESSION brand; the functions are scoped to it, so no cross-tenant mutation is possible.
 */
import type { DbPool, QueryContext } from '@brain/db';
import type { Pool } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

export interface MergeReview {
  review_id: string;
  brain_id_a: string;
  brain_id_b: string;
  trigger_reason: string;
  created_at: string;
}

export interface MergeReviewList {
  reviews: MergeReview[];
}

export type MergeDecision = 'merge' | 'reject';

export interface MergeResolveResult {
  resolved: boolean;
  decision?: 'merged' | 'rejected';
  reason?: string;
  canonical_brain_id?: string;
  merged_brain_id?: string;
}

export interface UnmergeResult {
  unmerged: boolean;
  reason?: string;
  brain_id?: string;
}

/** Pending merge candidates awaiting operator review, for the active brand (RLS-scoped). */
export async function listMergeReviews(
  brandId: string,
  correlationId: string,
  deps: { pool: DbPool },
): Promise<MergeReviewList> {
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    const r = await client.query<{
      review_id: string;
      brain_id_a: string;
      brain_id_b: string;
      trigger_reason: string;
      created_at: Date;
    }>(
      ctx,
      `SELECT review_id, brain_id_a, brain_id_b, trigger_reason, created_at
         FROM merge_review_queue
        WHERE brand_id = $1 AND status = 'pending'
        ORDER BY created_at ASC`,
      [brandId],
    );
    return {
      reviews: r.rows.map((x) => ({
        review_id: x.review_id,
        brain_id_a: x.brain_id_a,
        brain_id_b: x.brain_id_b,
        trigger_reason: x.trigger_reason,
        created_at: toIso(x.created_at),
      })),
    };
  } finally {
    client.release();
  }
}

/** Approve (merge brain_id_b → brain_id_a) or reject a pending review. */
export async function resolveMergeReview(
  brandId: string,
  reviewId: string,
  decision: MergeDecision,
  pool: Pool,
): Promise<MergeResolveResult> {
  if (!UUID_RE.test(reviewId)) {
    return { resolved: false, reason: 'not_found' };
  }
  const r = await pool.query<{ result: MergeResolveResult }>(
    'SELECT resolve_merge_review($1, $2, $3) AS result',
    [brandId, reviewId, decision],
  );
  return r.rows[0]!.result;
}

/** Split a previously-merged customer back out (reverses a merge). */
export async function unmergeCustomer(
  brandId: string,
  mergedBrainId: string,
  pool: Pool,
): Promise<UnmergeResult> {
  if (!UUID_RE.test(mergedBrainId)) {
    return { unmerged: false, reason: 'not_found' };
  }
  const r = await pool.query<{ result: UnmergeResult }>(
    'SELECT admin_unmerge_customer($1, $2) AS result',
    [brandId, mergedBrainId],
  );
  return r.rows[0]!.result;
}
