/**
 * serving-mart-flags.ts — the ADR-0019 WS-3 pre-baked-mart read seams (process-env flags, default OFF).
 *
 * ADR-0019 WS-3 moves three read-time recomputes into the transform tier (the single-query-ceiling
 * doctrine) and serves the pre-baked mart instead. Each repoint is behind its OWN env flag, DEFAULT OFF
 * (safe-off = today's live recompute), so merging changes NOTHING in prod until the flag is flipped ON
 * after a money-byte parity bake:
 *
 *   SERVING_CONTRIB_MARGIN_FROM_MART  → D5: contribution-margin.ts reads mv_gold_contribution_margin
 *                                        instead of recomputing CM1/CM2 from the ledger + spend + PG.
 *   SERVING_CHANNEL_ROAS_FROM_MART    → D6: get-channel-roas.ts reads mv_gold_channel_roas (pre-baked
 *                                        per-channel attributed/spend at the endpoint grain) instead of
 *                                        FX-blending attribution × spend at read time.
 *   SERVING_SEGMENT_FROM_MART         → D6: getCustomerSegmentMembers filters on the pre-baked `segment`
 *                                        column of gold_customer_scores instead of re-deriving the
 *                                        lifecycle ladder in TS over a full brand scan.
 *
 * These are PROCESS-level flags (a serving-tier toggle, not per-brand) — resolved once from process.env
 * so the readers stay a single source of truth for the toggle and are unit-testable. The value is a
 * strict "1"/"true" opt-in; anything else (unset, "0", "false", garbage) is the safe-off default. This
 * mirrors measurement-migration.ts's `spendView` seam (one place resolves which read path a metric uses).
 */

/** True iff a serving mart flag env value is the strict opt-in ("1"/"true", case-insensitive). */
function flagOn(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * The three ADR-0019 WS-3 mart flags. `env` defaults to process.env; injectable for unit tests so the
 * seam is exercised without mutating the process environment.
 */
export const CONTRIB_MARGIN_FROM_MART_ENV = 'SERVING_CONTRIB_MARGIN_FROM_MART';
export const CHANNEL_ROAS_FROM_MART_ENV = 'SERVING_CHANNEL_ROAS_FROM_MART';
export const SEGMENT_FROM_MART_ENV = 'SERVING_SEGMENT_FROM_MART';

/** D5 — read contribution margin from the pre-baked mart (mv_gold_contribution_margin). Default OFF. */
export function contribMarginFromMart(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CONTRIB_MARGIN_FROM_MART_ENV]);
}

/** D6 — read channel ROAS from the pre-baked mart (mv_gold_channel_roas). Default OFF. */
export function channelRoasFromMart(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CHANNEL_ROAS_FROM_MART_ENV]);
}

/** D6 — filter the segment on the pre-baked gold_customer_scores.segment column. Default OFF. */
export function segmentFromMart(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[SEGMENT_FROM_MART_ENV]);
}
