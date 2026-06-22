/**
 * recordRecommendationAction — append a human action on a recommendation (DB-AUDIT M7).
 *
 * The decision engine is recommend-only (doc 09): a human decides what to do with each
 * recommendation. This records that decision in the APPEND-ONLY ai_config.recommendation_action
 * ledger (the human decision-feedback loop) and reconciles the recommendation's derived status:
 *
 *   - 'served'    → audit only (the rec was surfaced to the user); status unchanged.
 *   - 'accepted'  → audit only; status stays 'open'. The recommendation.status enum has no
 *                   'accepted' value, and acceptance is recorded in the ledger — NOT mutating the
 *                   CHECK constraint keeps this slice additive. (See module README/decision note.)
 *   - 'dismissed' → status='dismissed' (the user closed it out).
 *   - 'snoozed'   → audit only; status stays 'open' (snooze is a UI/ledger concern, not a lifecycle
 *                   state — re-surfacing logic reads the ledger, not the status column).
 *   - 'reopened'  → status='open' (undo a dismissal).
 *
 * Two writes (append the action row, then conditionally update the rec status) — each runs under
 * the RLS-enforced pool with the brand GUC set from the QueryContext, mirroring the per-query
 * convention of generate-recommendations.ts. brand_id is the session brand (BFF), never the request.
 * The status UPDATE is brand-scoped AND RLS-isolated, so a cross-brand recommendation_id cannot be
 * touched. The ledger is append-only (brain_app has no UPDATE/DELETE — migration 0082).
 */

import type { DbPool, QueryContext } from '@brain/db';

/** The closed set of human actions on a recommendation (mirrors the 0082 CHECK constraint). */
export const RECOMMENDATION_ACTIONS = [
  'served',
  'accepted',
  'dismissed',
  'snoozed',
  'reopened',
] as const;
export type RecommendationActionKind = (typeof RECOMMENDATION_ACTIONS)[number];

export function isRecommendationAction(v: unknown): v is RecommendationActionKind {
  return typeof v === 'string' && (RECOMMENDATION_ACTIONS as readonly string[]).includes(v);
}

/** The appended ledger row (the serialized DTO returned to the BFF). */
export interface RecommendationAction {
  action_id: string;
  recommendation_id: string;
  action: RecommendationActionKind;
  actor: string;
  reason: string | null;
  created_at: string;
}

export interface RecordRecommendationActionInput {
  brandId: string;
  recommendationId: string;
  action: RecommendationActionKind;
  /** The authenticated user id (BFF), or 'system' for engine-emitted actions. */
  actor: string;
  reason?: string | null;
}

export interface RecordActionDeps {
  pool: DbPool;
}

/** Thrown when the target recommendation is not visible to the brand (RLS) or does not exist. */
export class RecommendationNotFoundError extends Error {
  constructor(recommendationId: string) {
    super(`Recommendation ${recommendationId} not found for this brand`);
    this.name = 'RecommendationNotFoundError';
  }
}

/** Thrown when the action is not one of the allowed kinds. */
export class InvalidRecommendationActionError extends Error {
  constructor(action: string) {
    super(`Unknown recommendation action: ${action}`);
    this.name = 'InvalidRecommendationActionError';
  }
}

function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

/** The recommendation.status the action drives (null → leave status unchanged). */
function nextStatusFor(action: RecommendationActionKind): 'dismissed' | 'open' | null {
  switch (action) {
    case 'dismissed':
      return 'dismissed';
    case 'reopened':
      return 'open';
    default:
      // served / accepted / snoozed — recorded in the ledger only.
      return null;
  }
}

export async function recordRecommendationAction(
  input: RecordRecommendationActionInput,
  correlationId: string,
  deps: RecordActionDeps,
): Promise<RecommendationAction> {
  if (!isRecommendationAction(input.action)) {
    throw new InvalidRecommendationActionError(String(input.action));
  }

  const { brandId, recommendationId, action, actor } = input;
  const reason = input.reason ?? null;
  const ctx: QueryContext = { brandId, correlationId };
  const client = await deps.pool.connect();
  try {
    // (a0) Visibility guard (brand isolation). A PG FK check bypasses RLS — without this, a brand
    //      could append a ledger row referencing a recommendation it cannot see (the row would be
    //      tagged with its own brand_id, so it never leaks INTO another brand, but it must not be
    //      writable at all). This SELECT runs under the brand GUC, so RLS hides another brand's rec
    //      → 0 rows → not found, and nothing is written.
    const exists = await client.query<{ recommendation_id: string }>(
      ctx,
      `SELECT recommendation_id FROM recommendation
        WHERE recommendation_id = $1 AND brand_id = $2`,
      [recommendationId, brandId],
    );
    if (exists.rows.length === 0) {
      throw new RecommendationNotFoundError(recommendationId);
    }

    // (a) Append the action row (RLS-isolated, append-only — migration 0082).
    const inserted = await client.query<{
      action_id: string;
      recommendation_id: string;
      action: RecommendationActionKind;
      actor: string;
      reason: string | null;
      created_at: Date;
    }>(
      ctx,
      `INSERT INTO recommendation_action (brand_id, recommendation_id, action, actor, reason)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING action_id, recommendation_id, action, actor, reason, created_at`,
      [brandId, recommendationId, action, actor, reason],
    );

    // (b) Reconcile the recommendation's derived status (RLS + brand_id scope the update).
    const nextStatus = nextStatusFor(action);
    if (nextStatus) {
      const upd = await client.query(
        ctx,
        `UPDATE recommendation SET status = $1, updated_at = NOW()
          WHERE recommendation_id = $2 AND brand_id = $3`,
        [nextStatus, recommendationId, brandId],
      );
      if ((upd.rowCount ?? 0) === 0) {
        throw new RecommendationNotFoundError(recommendationId);
      }
    }

    const row = inserted.rows[0]!;
    return {
      action_id: row.action_id,
      recommendation_id: row.recommendation_id,
      action: row.action,
      actor: row.actor,
      reason: row.reason ?? null,
      created_at: toIso(row.created_at),
    };
  } finally {
    client.release();
  }
}
