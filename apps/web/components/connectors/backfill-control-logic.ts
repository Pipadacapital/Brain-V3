/**
 * backfill-control-logic — pure decision helpers for the "Pull historical data" trigger control.
 *
 * Extracted out of backfill-control.tsx so they are unit-testable node-side (the .tsx module
 * imports client-only `@/...` UI barrels + hooks that the node-env vitest can't resolve — same
 * reason backfill-depth.ts lives apart from the component). No React, no `@/` imports.
 *
 * 0127+ restore: the depth/period picker + trigger button must be available in EVERY terminal
 * state (completed / partial / failed), not only when idle — it is hidden ONLY while a job is
 * actively queued/running. The single trigger control re-labels itself for failed/partial jobs.
 */

import type { BackfillJobProgress } from '@brain/contracts';

/**
 * triggerLabel — the single re-trigger control's copy + aria-label, context-aware on the
 * current terminal job status. A failed/partial job re-labels the control as "Retry Import";
 * idle or a completed job reads "Import History".
 */
export function triggerLabel(status: BackfillJobProgress['status'] | undefined): {
  text: string;
  ariaLabel: string;
} {
  if (status === 'failed' || status === 'partial') {
    return { text: 'Retry Import', ariaLabel: 'Retry backfill import' };
  }
  return { text: 'Import History', ariaLabel: 'Import order history' };
}

/**
 * shouldShowTriggerControl — the depth-picker + trigger button is visible iff the caller may
 * trigger (brand_admin+) AND there is no actively-running job. Idle AND every terminal state
 * (completed / partial / failed) qualify — only a queued/running job hides the control.
 */
export function shouldShowTriggerControl(
  canTrigger: boolean,
  status: BackfillJobProgress['status'] | undefined,
): boolean {
  const hasActiveJob = status === 'queued' || status === 'running';
  return canTrigger && !hasActiveJob;
}
