'use client';

/**
 * use-sync-now — feat-connector-sync-now (Track B).
 *
 * Mirrors use-backfill.ts. Two hooks:
 *
 *   useSyncStatus(connectorId)  — polls GET /api/v1/connectors/:id/status (REUSED, not a new
 *       endpoint) while the connector is syncing. Returns the real ConnectorInstanceResponse
 *       straight from connector_sync_status — sync_state / last_sync_at / last_error.
 *         - syncing  → polls every 3s (refetchInterval)
 *         - terminal (connected | waiting_for_data | error) → stops polling
 *
 *   useTriggerSync(connectorId) — POSTs /api/v1/connectors/:id/sync. On success, invalidates
 *       the status query so polling begins immediately (the worker flips state→'syncing').
 *
 * Honesty: sync_state / last_sync_at / last_error are passed through unchanged. A failed sync
 * surfaces state='error' + last_error (e.g. TOKEN_EXPIRED → reconnect) — never a fake "synced".
 *
 * Error codes surfaced by the trigger (callers inspect error.code):
 *   'RECONNECT_REQUIRED'      → token expired; reconnect prompt.
 *   'SYNC_ALREADY_RUNNING'    → overlap lock held (already syncing) — no duplicate run.
 *   'SYNC_ALREADY_REQUESTED'  → a sync is already queued for this connector.
 *   403                       → manager/analyst — trigger button is hidden.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { syncApi, BffApiError } from '@/lib/api/client';
import type { ConnectorInstanceResponse, SyncState } from '@/lib/api/types';

/** Query key factory — stable per connectorId. */
export function syncStatusKey(connectorId: string) {
  return ['connectors', connectorId, 'sync-status'] as const;
}

/** True when the connector is actively syncing (non-terminal). */
function isSyncing(state: SyncState): boolean {
  return state === 'syncing';
}

/**
 * useSyncStatus — TanStack Query hook that polls the connector status while syncing.
 *
 * @param connectorId - The connector_instance UUID to read status for.
 * @param enabled     - Set false to skip fetching entirely.
 */
export function useSyncStatus(connectorId: string, enabled = true) {
  return useQuery<ConnectorInstanceResponse>({
    queryKey: syncStatusKey(connectorId),
    queryFn: () => syncApi.getSyncStatus(connectorId),
    enabled: !!connectorId && enabled,
    // Poll every 3s while syncing; stop once terminal (returns false to disable interval).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return false;
      return isSyncing(data.sync_state) ? 3_000 : false;
    },
    // Always re-fetch on mount for fresh status.
    staleTime: 0,
    // 404 = no status row yet (connector never synced) — don't retry-storm.
    retry: (failureCount, error) => {
      if (error instanceof BffApiError && error.status === 404) return false;
      return failureCount < 2;
    },
  });
}

/**
 * useTriggerSync — mutation that POSTs /api/v1/connectors/:id/sync.
 *
 * On success, invalidates the status query so useSyncStatus immediately re-fetches and
 * begins polling (the worker has flipped connector_sync_status.state to 'syncing').
 *
 * Mapped error states (callers inspect error.code):
 *   'RECONNECT_REQUIRED'      → reconnect prompt (data-testid: sync-reconnect-required)
 *   'SYNC_ALREADY_RUNNING' | 'SYNC_ALREADY_REQUESTED' → "already syncing" inline state
 *   403                        → manager/analyst — button hidden
 */
export function useTriggerSync(connectorId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => syncApi.triggerSync(connectorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: syncStatusKey(connectorId) });
    },
  });
}
