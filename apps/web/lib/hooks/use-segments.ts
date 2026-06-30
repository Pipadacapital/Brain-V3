'use client';

/**
 * Saved-segments hooks — react-query bindings for the P2 saved-segments BFF surface
 * (GET/POST/PUT/DELETE /v1/segments + POST /v1/segments/preview).
 *
 * Query key is prefixed with 'segments' so it auto-invalidates on brand switch when
 * brand-switcher.tsx invalidates by prefix. brand + actor come from the session on the
 * server (D-1) — never passed from the client. The `definition` is an opaque rule tree.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { segmentsApi } from '@/lib/api/client';

export const SEGMENTS_QUERY_KEY = ['segments'] as const;

/** List the brand's saved segments (newest first). Honest-empty = []. */
export function useSavedSegments() {
  return useQuery({
    queryKey: [...SEGMENTS_QUERY_KEY, 'list'],
    queryFn: () => segmentsApi.list(),
    staleTime: 60_000,
  });
}

/** Create a saved segment; refreshes the list on success. */
export function useCreateSegment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; definition: Record<string, unknown> }) =>
      segmentsApi.create(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY });
    },
  });
}

/** Rename and/or edit a saved segment's rule tree; refreshes the list on success. */
export function useUpdateSegment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...body
    }: {
      id: string;
      name?: string;
      definition?: Record<string, unknown>;
    }) => segmentsApi.update(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY });
    },
  });
}

/** Delete a saved segment; refreshes the list on success. */
export function useDeleteSegment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => segmentsApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SEGMENTS_QUERY_KEY });
    },
  });
}

/**
 * Preview the customers a definition would match WITHOUT persisting (reuses the customer-base
 * count path). A mutation (not a query) since it carries the in-progress, unsaved rule tree.
 */
export function usePreviewSegment() {
  return useMutation({
    mutationFn: (definition: Record<string, unknown>) => segmentsApi.preview(definition),
  });
}
