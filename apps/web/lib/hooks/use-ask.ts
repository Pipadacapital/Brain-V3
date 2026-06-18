'use client';

/**
 * use-ask — Ask Brain / Decision-Intelligence (Phase 8, feat-decision-intelligence-inputs).
 *
 * A single-question mutation: the user asks a natural-language question, the BFF resolves it
 * to a registry metric_binding (the model NEVER produces a number / NEVER emits SQL), the
 * metric-engine computes the certified number deterministically (I-ST01), and the BFF returns
 * the AskBrainResponse (answer | no_data | refusal).
 *
 * This is a MUTATION (POST), not a cached query — every ask is a distinct user action with its
 * own snapshot/provenance. We keep the latest result in mutation state (data) for rendering.
 *
 * Honesty (requirement §6): kind:'refusal' carries NO number — the UI renders the honest
 * "no certified metric answers this" card. The raw question is sent in-memory only; the server
 * persists a REDACTED form (the client never echoes it back to provenance).
 */

import { useMutation } from '@tanstack/react-query';
import { askApi } from '@/lib/api/client';
import type { AskBrainResponse } from '@/lib/api/types';

/**
 * useAsk — POSTs a question to /api/v1/ask and exposes the certified AskBrainResponse.
 *
 * Usage:
 *   const ask = useAsk();
 *   ask.mutate('How much revenue did we realize last month?');
 *   ask.data // AskBrainResponse | undefined
 */
export function useAsk() {
  return useMutation<AskBrainResponse, unknown, string>({
    mutationKey: ['ask-brain'],
    mutationFn: (question: string) => askApi.ask({ question }),
  });
}
