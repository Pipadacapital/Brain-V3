'use client';

/**
 * useBackfillProgress — polls the backfill job progress while the job is active.
 *
 * C0 hook (feat-connector-backfill).
 *
 * Polling behaviour:
 *   - Active (status in { queued, running }): polls every 3s via refetchInterval.
 *   - Terminal (completed | partial | failed): stops polling (refetchInterval=false).
 *   - No job (404 error): does not poll.
 *
 * D-8 honesty: estimated_total=null is passed through unchanged — the UI renders
 * the indeterminate "Collecting your data..." state, never 0%.
 *
 * Error codes surfaced:
 *   - RECONNECT_REQUIRED  (409 D-7): connector token expired; must reconnect first.
 *   - BACKFILL_ALREADY_RUNNING (409 D-9): another job is active for this connector.
 *   - 403: caller is manager-role (D-15); trigger button must be disabled.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { backfillApi, BffApiError } from '@/lib/api/client';
import type { BackfillJobProgress } from '@brain/contracts';

/** Query key factory — stable per connectorId. */
function backfillProgressKey(connectorId: string) {
  return ['connectors', connectorId, 'backfill-progress'] as const;
}

/** True when the job is in a non-terminal state. */
function isActive(status: BackfillJobProgress['status']): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * useBackfillProgress — TanStack Query hook that polls while the job is active.
 *
 * @param connectorId - The connector_instance UUID to poll progress for.
 * @param enabled     - Set false to skip fetching entirely (e.g. before a job exists).
 */
export function useBackfillProgress(connectorId: string, enabled = true) {
  return useQuery({
    queryKey: backfillProgressKey(connectorId),
    queryFn: () => backfillApi.getBackfillProgress(connectorId),
    enabled: !!connectorId && enabled,
    // Poll every 3s while active; stop on terminal state (returns false to disable interval).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return isActive(data.status) ? 3_000 : false;
    },
    // Stale immediately on mount — always re-fetch for fresh progress.
    staleTime: 0,
    // Do not throw on 404 (no job yet) — keep returning undefined data.
    retry: (failureCount, error) => {
      if (error instanceof BffApiError && error.status === 404) return false;
      return failureCount < 2;
    },
  });
}

/**
 * useTriggerBackfill — mutation that POSTs /api/v1/connectors/:id/backfill.
 *
 * On success, immediately invalidates the progress query so the UI switches
 * to polling mode without waiting for the next tick.
 *
 * Mapped error states (callers inspect error.code):
 *   'RECONNECT_REQUIRED'      → show reconnect prompt (data-testid: backfill-reconnect-required)
 *   'BACKFILL_ALREADY_RUNNING' → show "already running" state
 *   403                        → manager role — button should be disabled/hidden
 */
export function useTriggerBackfill(connectorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => backfillApi.triggerBackfill(connectorId),
    onSuccess: () => {
      // Invalidate so useBackfillProgress immediately re-fetches and begins polling.
      void queryClient.invalidateQueries({ queryKey: backfillProgressKey(connectorId) });
    },
  });
}
