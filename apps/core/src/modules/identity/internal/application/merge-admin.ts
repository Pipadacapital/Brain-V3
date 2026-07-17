/**
 * merge-admin — identity merge/unmerge control-plane (P0-C).
 *
 * listMergeReviews: read the pending merge_review_queue for the active brand (RLS via @brain/db).
 * resolveMergeReview / unmergeCustomer: operator actions delegated to the SECURITY DEFINER
 * functions resolve_merge_review() / admin_unmerge_customer() (migration 0039). brandId is the
 * SESSION brand; the functions are scoped to it, so no cross-tenant mutation is possible.
 */
import type { IdentityReader } from '../infrastructure/neo4j-identity-reader.js';

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
  // SPEC: A.2.4 (WA-19) — reversal audit surface (present when unmerged=true).
  survivor_brain_id?: string;
  merge_event_id?: string;
}

// MEDALLION REALIGNMENT (Epic 3 / ADR-0004): identity is the Neo4j SoR. The merge_review_queue + the
// SECURITY DEFINER resolve_merge_review/admin_unmerge_customer functions are replaced by graph ops.

/** Pending merge candidates awaiting operator review, for the active brand. */
export async function listMergeReviews(
  brandId: string,
  _correlationId: string,
  deps: { reader: IdentityReader },
): Promise<MergeReviewList> {
  const reviews = await deps.reader.listMergeReviews(brandId);
  return {
    reviews: reviews.map((x) => ({
      review_id: x.review_id,
      brain_id_a: x.brain_id_a,
      brain_id_b: x.brain_id_b,
      trigger_reason: x.trigger_reason,
      created_at: toIso(x.created_at),
    })),
  };
}

/** Approve (merge brain_id_b → brain_id_a) or reject a pending review. */
export async function resolveMergeReview(
  brandId: string,
  reviewId: string,
  decision: MergeDecision,
  reader: IdentityReader,
  opts?: { actor?: string },
): Promise<MergeResolveResult> {
  if (!UUID_RE.test(reviewId)) {
    return { resolved: false, reason: 'not_found' };
  }
  const r = await reader.resolveMergeReview(brandId, reviewId, decision === 'merge' ? 'approve' : 'reject', opts);
  if (!r.resolved) return { resolved: false, reason: r.reason };
  return { resolved: true, decision: decision === 'merge' ? 'merged' : 'rejected' };
}

/**
 * SPEC: A.2.4 (WA-19) — split a previously-merged customer back out (reverses a merge).
 * Delegates the bi-temporal reversal + audit to the reader; `onUnmerged` (optional) is the
 * downstream dirty-enqueue seam the route wires (ADR-0015 WS3: a direct PG write into
 * ops.restitch_pending + ops.journey_reversion_pending — formerly the identity.unmerged.v1 Kafka
 * publish) — kept as a callback so the identity application stays free of an infrastructure
 * dependency (DIP). Fires ONLY on a real reversal (unmerged=true).
 */
export async function unmergeCustomer(
  brandId: string,
  mergedBrainId: string,
  reader: IdentityReader,
  opts?: {
    actor?: string;
    reason?: string;
    onUnmerged?: (evt: {
      brandId: string;
      restoredBrainId: string;
      survivorBrainId?: string;
      mergeEventId?: string;
      actor: string;
      reason?: string;
    }) => Promise<void>;
  },
): Promise<UnmergeResult> {
  if (!UUID_RE.test(mergedBrainId)) {
    return { unmerged: false, reason: 'not_found' };
  }
  const r = await reader.unmergeCustomer(brandId, mergedBrainId, { actor: opts?.actor, reason: opts?.reason });
  if (r.unmerged && opts?.onUnmerged) {
    await opts.onUnmerged({
      brandId,
      restoredBrainId: r.brain_id ?? mergedBrainId,
      survivorBrainId: r.survivor_brain_id,
      mergeEventId: r.merge_event_id,
      actor: opts.actor ?? 'system',
      reason: opts.reason,
    });
  }
  return r;
}
