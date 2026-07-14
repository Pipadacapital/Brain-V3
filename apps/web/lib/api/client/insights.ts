// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import { z } from 'zod';
import {
  SavedSegmentListSchema,
  SavedSegmentDtoSchema,
  SegmentPreviewResultSchema,
  AskBrainResultSchema,
} from '@brain/contracts';
import type {
  AnalyticsInsightsBriefingResponse,
  ConsentCoverageResponse,
  ConsentSuppressionSummaryResponse,
  ConsentGateActivityResponse,
  ConsentWindowConfigResponse,
  CapiFeedbackSummaryResponse,
  CapiFeedbackEventsResponse,
  CapiFeedbackDeletionsResponse,
  AskBrainRequest,
  AskBrainResponse,
} from '../types';
import { bffFetch, generateRequestId, parseData, type BffEnvelope } from './core';

// ── Insight + Opportunity Engine + AI Copilot ────────────────────────────────
export const insightsApi = {
  /**
   * GET /api/v1/insights/briefing — deterministic insight/opportunity/risk feed + daily briefing
   * over the Gold marts. Numbers come from the marts, never from a model. Honest no_data state.
   */
  getBriefing: async (): Promise<AnalyticsInsightsBriefingResponse> => {
    const { data } = await bffFetch<BffEnvelope<AnalyticsInsightsBriefingResponse>>(
      '/v1/insights/briefing',
    );
    return data;
  },
};

// ── Saved segments (P2) — CRUD + preview over ops.saved_segment ──────────────
// BFF-only, session-authed. Brand + actor from session (D-1) — NEVER in the body. The segment
// `definition` is an opaque JSON rule tree (validated shape only). Responses parsed at the seam.
export const segmentsApi = {
  /** GET /v1/segments — the brand's saved segments (newest first). Honest-empty = []. */
  list: async (): Promise<z.infer<typeof SavedSegmentListSchema>> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/segments');
    return parseData(SavedSegmentListSchema, env);
  },

  /** POST /v1/segments — create one segment. */
  create: async (body: {
    name: string;
    definition: Record<string, unknown>;
  }): Promise<z.infer<typeof SavedSegmentDtoSchema>> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/segments', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return parseData(SavedSegmentDtoSchema, env);
  },

  /** PUT /v1/segments/:id — rename and/or edit the rule tree. */
  update: async (
    id: string,
    body: { name?: string; definition?: Record<string, unknown> },
  ): Promise<z.infer<typeof SavedSegmentDtoSchema>> => {
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/segments/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    return parseData(SavedSegmentDtoSchema, env);
  },

  /** DELETE /v1/segments/:id — remove a segment (204 No Content). */
  remove: async (id: string): Promise<void> => {
    await bffFetch<void>(`/v1/segments/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** POST /v1/segments/preview — count matching customers WITHOUT persisting. */
  preview: async (definition: Record<string, unknown>): Promise<z.infer<typeof SegmentPreviewResultSchema>> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/segments/preview', {
      method: 'POST',
      body: JSON.stringify({ definition }),
    });
    return parseData(SegmentPreviewResultSchema, env);
  },
};

// ── Consent / Compliance (D13 — feat-d13-consent-cancontact Track C) ──────────
// BFF-only, session-authed. Brand from session (D-1). Unwrap { request_id, data }.
// NO raw PII — aggregate counts + decision metadata + a fixed regulatory window.
// state:'no_data' is preserved (fail-closed: empty SoR == "blocked by default").

export const consentApi = {
  /** GET /api/v1/consent/coverage — per-category granted/withdrawn subject counts. */
  getCoverage: async (): Promise<ConsentCoverageResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentCoverageResponse>>(
      '/v1/consent/coverage',
    );
    return data;
  },

  /** GET /api/v1/consent/suppression-summary — marketing suppression counts. */
  getSuppressionSummary: async (): Promise<ConsentSuppressionSummaryResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentSuppressionSummaryResponse>>(
      '/v1/consent/suppression-summary',
    );
    return data;
  },

  /** GET /api/v1/consent/gate-activity — last-N can_contact() decisions by reason. */
  getGateActivity: async (): Promise<ConsentGateActivityResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentGateActivityResponse>>(
      '/v1/consent/gate-activity',
    );
    return data;
  },

  /** GET /api/v1/consent/window-config — the read-only 9–9 IST send window. */
  getWindowConfig: async (): Promise<ConsentWindowConfigResponse> => {
    const { data } = await bffFetch<BffEnvelope<ConsentWindowConfigResponse>>(
      '/v1/consent/window-config',
    );
    return data;
  },
};

// ── Conversion-Feedback / CAPI (Phase 6 — feat-capi-conversion-feedback Track C) ──────
//
// Read-only reads for the stakeholder-visible Conversion-Feedback surface. The BFF wraps
// each payload in { request_id, data }; we unwrap to the component-facing response type
// (declared in ./types, field-for-field with core's get-capi-feedback.ts DTO). No PII.
export const capiFeedbackApi = {
  /** GET /api/v1/feedback/capi/summary — passed-back vs blocked-by-consent + match quality. */
  getSummary: async (): Promise<CapiFeedbackSummaryResponse> => {
    const { data } = await bffFetch<BffEnvelope<CapiFeedbackSummaryResponse>>(
      '/v1/feedback/capi/summary',
    );
    return data;
  },

  /** GET /api/v1/feedback/capi/events — the last-N passback log rows (truncated event_id). */
  getEvents: async (): Promise<CapiFeedbackEventsResponse> => {
    const { data } = await bffFetch<BffEnvelope<CapiFeedbackEventsResponse>>(
      '/v1/feedback/capi/events',
    );
    return data;
  },

  /** GET /api/v1/feedback/capi/deletions — the last-N retroactive-deletion requests. */
  getDeletions: async (): Promise<CapiFeedbackDeletionsResponse> => {
    const { data } = await bffFetch<BffEnvelope<CapiFeedbackDeletionsResponse>>(
      '/v1/feedback/capi/deletions',
    );
    return data;
  },
};

// ── Ask Brain / Decision-Intelligence (Phase 8 — feat-decision-intelligence-inputs) ──────
//
// POST /api/v1/ask — the single-question Decision-Intelligence read. BFF-only, session-authed,
// brand from session (D-1). The web app NEVER queries metric tables / StarRocks and NEVER calls
// the model directly — the BFF orchestrates resolve→engine-compute→trust→provenance and returns
// the certified AskBrainResponse. D-10: unwrap { request_id, data }.
//
// The model resolves the question to a registry binding; the metric-engine computes the number
// (I-ST01). kind:'refusal' → no number is shown (off-domain honesty). Money is bigint-minor
// strings + currency — format with formatMoneyDisplay, never /100, never BigInt(undefined).

export const askApi = {
  /** POST /api/v1/ask — resolve a NL question to a certified metric answer (or honest refusal). */
  ask: async (body: AskBrainRequest): Promise<AskBrainResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/ask', {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: generateRequestId(),
    });
    return parseData(AskBrainResultSchema, env);
  },
};
