/**
 * connector.backfill.api.v1 — Frozen API contract for backfill trigger + progress.
 *
 * Produced by Track A (data-engineer) — A0 freeze.
 * Consumed by:
 *   Track B (@backend-developer): implements POST /api/v1/connectors/:id/backfill (ADR-BF-3)
 *                                  and GET /api/v1/connectors/:id/jobs (ADR-BF-4)
 *   Track C (@frontend-web-developer): renders BackfillJobProgress into UI
 *
 * All responses use the standard `{ request_id, data }` envelope (success)
 * or `{ request_id, error: { code, message } }` (error).
 *
 * HTTP status codes:
 *   202 — backfill queued (BackfillTriggerResponse in data)
 *   409 — RECONNECT_REQUIRED (D-7) or BACKFILL_ALREADY_RUNNING (D-9)
 *   403 — insufficient role (manager or unauthenticated)
 *   404 — connector_instance not found for this brand
 *
 * Authz: owner/brand_admin only (D-15). The requireRole('brand_admin') hook at
 *   apps/core/src/main.ts:714 gates this endpoint — managers return 403.
 */

// ── Trigger response (POST /api/v1/connectors/:id/backfill → 202) ─────────────

export interface BackfillTriggerResponse {
  /** UUID of the created backfill_job row. */
  job_id: string;
  /** Always 'queued' on a 202 response. */
  status: 'queued';
}

// ── Progress shape (GET /api/v1/connectors/:id/jobs) ─────────────────────────

export interface BackfillJobProgress {
  /** UUID of the backfill_job row. */
  job_id: string;

  /** Current job status (D-12 CHECK constraint values). */
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed';

  /**
   * Number of Shopify orders processed so far.
   * Real count updated after every page (D-14). Never fabricated or 0 when work is done.
   */
  records_processed: number;

  /**
   * Shopify order count for the 24-month window (countOrders with created_at_min=2Y-ago).
   * null = count call failed; UI shows "Collecting your data..." without a percentage (D-8 / HP-1).
   * Never a fabricated number (§2 honesty invariant).
   */
  estimated_total: number | null;

  /**
   * Completion percentage: Math.min(100, Math.round((records_processed / estimated_total) * 100)).
   * null when estimated_total is null (D-8 honesty: no percentage without a real denominator).
   */
  percent: number | null;

  /**
   * ISO-8601 UTC — oldest Shopify order processed_at seen so far.
   * Updated after each page. Lets the UI show "data back to <date>".
   * null until first page is processed.
   */
  cursor_date: string | null;

  /**
   * Honest label describing the depth achieved (HP-3).
   * Written at completion: "24 months" if oldest order ≈ now-24mo,
   * "since store creation (N months)" if the store is younger.
   * null while the job is queued or running.
   */
  achieved_depth_label: string | null;

  /**
   * Human-readable reason for failed/partial terminal state.
   * Codes: 'SHOPIFY_AUTH_ERROR' (401 mid-pull, SP-3),
   *        'RECONNECT_REQUIRED' (null token at worker start, ADR-BF-11),
   *        'PAGE_ERROR_MAX_RETRY' (unrecoverable page error after retries).
   * null for queued/running/completed.
   */
  failure_reason: string | null;

  /** ISO-8601 UTC — when the job transitioned from queued to running. null if not yet started. */
  started_at: string | null;

  /** ISO-8601 UTC — when the job reached a terminal state (completed/partial/failed). null otherwise. */
  completed_at: string | null;
}

// ── Error response codes ──────────────────────────────────────────────────────

/**
 * 409 error codes.
 * Returned in { request_id, error: { code, message } } envelope.
 */
export type BackfillErrorCode = 'RECONNECT_REQUIRED' | 'BACKFILL_ALREADY_RUNNING';

export interface BackfillErrorResponse {
  code: BackfillErrorCode;
  message: string;
}

// ── Convenience type guards ────────────────────────────────────────────────────

export function isBackfillTerminal(
  status: BackfillJobProgress['status'],
): status is 'completed' | 'partial' | 'failed' {
  return status === 'completed' || status === 'partial' || status === 'failed';
}

export function isBackfillInProgress(
  status: BackfillJobProgress['status'],
): status is 'queued' | 'running' {
  return status === 'queued' || status === 'running';
}
