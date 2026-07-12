// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import { CustomerJourneyTimelineSchema, JourneyTraceSchema } from '@brain/contracts';
import type {
  CustomerJourneyTimeline,
  JourneyTrace,
  MetricLineageResult,
  SemanticMetricsCatalog,
  ContributionMarginResponse,
} from '../types';
import { bffFetch, parseData, type BffEnvelope } from './core';

// ── Wave B — Journey deep-dive APIs (B.3): trace an order, a customer timeline ──
// (GET /v1/journeys/compare was removed in the Wave-3 cleanup — AUD-IMPL-020.)
// Reachable at core /api/v1/journeys/* + /api/v1/customers/:id/journey (AMD-14 canonical prefix).
export const journeyApi = {
  /** GET /api/v1/journeys/trace?order_id=&lookback_days= — the touchpoints preceding an order
   *  + per-touch matched_via + identity_evidence (the explainability surface). */
  getTrace: async (orderId: string, lookbackDays?: number): Promise<JourneyTrace> => {
    const qs = new URLSearchParams({ order_id: orderId });
    if (lookbackDays != null) qs.set('lookback_days', String(lookbackDays));
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/journeys/trace?${qs.toString()}`);
    return parseData(JourneyTraceSchema, env);
  },

  /** GET /api/v1/customers/:brainId/journey?cursor=&limit= — newest-first paginated timeline. */
  getCustomerJourney: async (
    brainId: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<CustomerJourneyTimeline> => {
    const qs = new URLSearchParams();
    if (opts?.cursor) qs.set('cursor', opts.cursor);
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/customers/${encodeURIComponent(brainId)}/journey${suffix}`,
    );
    return parseData(CustomerJourneyTimelineSchema, env);
  },
};

// ── Wave C/D — Metrics: lineage ("prove this number"), semantic catalog, contribution margin ──
export const metricsApi = {
  /** GET /api/v1/metrics/:metric/lineage?date= — the source facts (tables, row counts, job
   *  versions, freshness) behind a served metric. Trust surface: every number traces to measurement. */
  getLineage: async (metric: string, date?: string | null): Promise<MetricLineageResult> => {
    const suffix = date ? `?date=${encodeURIComponent(date)}` : '';
    const env = await bffFetch<BffEnvelope<MetricLineageResult>>(
      `/v1/metrics/${encodeURIComponent(metric)}/lineage${suffix}`,
    );
    return env.data;
  },

  /** GET /api/v1/semantic/metrics — the certified, governed metric catalog (Wave D). */
  getSemanticCatalog: async (): Promise<SemanticMetricsCatalog> => {
    const env = await bffFetch<BffEnvelope<SemanticMetricsCatalog>>(`/v1/semantic/metrics`);
    return env.data;
  },

  /** GET /api/v1/analytics/contribution-margin?as_of= — true profit (net → COGS → CM1 → mktg → CM2). */
  getContributionMargin: async (asOf?: string): Promise<ContributionMarginResponse> => {
    const suffix = asOf ? `?as_of=${encodeURIComponent(asOf)}` : '';
    const env = await bffFetch<BffEnvelope<ContributionMarginResponse>>(
      `/v1/analytics/contribution-margin${suffix}`,
    );
    return env.data;
  },
};
