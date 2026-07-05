'use client';

/**
 * ML hooks — react-query bindings for the C5 ML platform (model registry + serving).
 *
 * Query keys are prefixed with 'ml' so they auto-invalidate on brand switch. Promoting a model
 * invalidates the model list so the new stage badges + the archived-prior-production reflect immediately.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { mlApi } from '@/lib/api/client';
import type { MlModelStage } from '@/lib/api/types';

const ML_QUERY_KEY = ['ml'] as const;

/** useModels — the active brand's model registry. */
export function useModels() {
  return useQuery({
    queryKey: [...ML_QUERY_KEY, 'models'],
    queryFn: () => mlApi.listModels(),
    staleTime: 60_000,
  });
}

/** usePromoteModel — move a model to a new lifecycle stage, then refresh the registry. */
export function usePromoteModel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ modelId, stage }: { modelId: string; stage: MlModelStage }) =>
      mlApi.promote(modelId, stage),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ML_QUERY_KEY });
    },
  });
}

/**
 * useCustomerScore — serve a customer's RFM/churn score by brain_id (honest no_data).
 * On-demand only (enabled when a brain_id is provided); serving also logs a prediction_log row,
 * so we never auto-fire on mount.
 */
export function useCustomerScore(brainId: string | null) {
  return useQuery({
    queryKey: [...ML_QUERY_KEY, 'customer-score', brainId],
    queryFn: () => mlApi.customerScore(brainId!),
    enabled: !!brainId,
    staleTime: 0,
  });
}
