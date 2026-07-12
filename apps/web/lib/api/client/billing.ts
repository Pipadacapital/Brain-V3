// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import {
  BillingPeriodsSchema,
  SealPeriodResultSchema,
  InspectableBillSchema,
  InvoiceSchema,
  IssueInvoiceResultSchema,
  IssueCreditNoteResultSchema,
  RecommendationsSchema,
  GenerateRecommendationsResultSchema,
  RecommendationActionSchema,
  ModelListSchema,
  ModelSchema,
  CustomerScoreResultSchema,
} from '@brain/contracts';
import type {
  BillingPeriodsResponse,
  SealPeriodResultResponse,
  InspectableBillResponse,
  InvoiceResponse,
  IssueInvoiceResultResponse,
  IssueCreditNoteResultResponse,
  RecommendationsResponse,
  GenerateRecommendationsResultResponse,
  RecommendationActionResponse,
  RecommendationActionKind,
  MlModel,
  MlModelListResponse,
  MlModelStage,
  MlCustomerScoreResponse,
} from '../types';
import { bffFetch, generateRequestId, parseData, type BffEnvelope } from './core';

/**
 * Billing API — the realized-GMV meter (P1). Maps to /api/v1/billing/* in the frontend-api module.
 * Money is bigint-minor string + currency_code; the UI never does float math (I-S07).
 */
export const billingApi = {
  /** GET /api/v1/billing/periods — the active brand's sealed billing periods (bill basis). */
  getPeriods: async (): Promise<BillingPeriodsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/periods');
    return parseData(BillingPeriodsSchema, env);
  },

  /** POST /api/v1/billing/periods/seal — meter + seal one 'YYYY-MM' period (idempotent). */
  sealPeriod: async (period: string): Promise<SealPeriodResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/periods/seal', {
      method: 'POST',
      body: JSON.stringify({ period }),
    });
    return parseData(SealPeriodResultSchema, env);
  },

  /** GET /api/v1/billing/bill?period=YYYY-MM — the inspectable bill for a sealed period. */
  getBill: async (period: string): Promise<InspectableBillResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/billing/bill?period=${encodeURIComponent(period)}`,
    );
    return parseData(InspectableBillSchema, env);
  },

  /** GET /api/v1/billing/invoice?period=YYYY-MM — the issued GST invoice for a period. */
  getInvoice: async (period: string): Promise<InvoiceResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/billing/invoice?period=${encodeURIComponent(period)}`,
    );
    return parseData(InvoiceSchema, env);
  },

  /** POST /api/v1/billing/invoice/issue — issue the GST invoice for a sealed period (idempotent). */
  issueInvoice: async (period: string): Promise<IssueInvoiceResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/invoice/issue', {
      method: 'POST',
      body: JSON.stringify({ period }),
    });
    return parseData(IssueInvoiceResultSchema, env);
  },

  /** POST /api/v1/billing/invoice/credit-note — issue an immutable credit note (full or partial). */
  issueCreditNote: async (
    period: string,
    reason: string,
    taxableMinor?: string,
  ): Promise<IssueCreditNoteResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/billing/invoice/credit-note', {
      method: 'POST',
      body: JSON.stringify(
        taxableMinor != null ? { period, reason, taxable_minor: taxableMinor } : { period, reason },
      ),
    });
    return parseData(IssueCreditNoteResultSchema, env);
  },
};

/**
 * Recommendation API — the deterministic decision engine (doc 09). Maps to /api/v1/recommendations.
 * Recommend-only; money fields in evidence are bigint-minor strings (the UI never floats them).
 */
export const recommendationApi = {
  /** GET /api/v1/recommendations — the active brand's open recommendations (Morning Brief). */
  list: async (): Promise<RecommendationsResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/recommendations');
    return parseData(RecommendationsSchema, env);
  },

  /** POST /api/v1/recommendations/refresh — run the detectors; returns raise/expire counts. */
  refresh: async (): Promise<GenerateRecommendationsResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/recommendations/refresh', {
      method: 'POST',
    });
    return parseData(GenerateRecommendationsResultSchema, env);
  },

  /**
   * POST /api/v1/recommendations/:id/action — record a human action (accept/dismiss/snooze/…).
   * The append-only decision-feedback loop; returns the recorded ledger row.
   */
  action: async (
    recommendationId: string,
    action: RecommendationActionKind,
    reason?: string,
  ): Promise<RecommendationActionResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/recommendations/${encodeURIComponent(recommendationId)}/action`,
      {
        method: 'POST',
        body: JSON.stringify({ action, ...(reason ? { reason } : {}) }),
        idempotencyKey: generateRequestId(),
      },
    );
    return parseData(RecommendationActionSchema, env);
  },
};

/**
 * mlApi — the C5 ML platform surface (model registry + serving). BFF-only (I-ST01).
 */
export const mlApi = {
  /** GET /api/v1/ml/models — the active brand's model registry. */
  listModels: async (): Promise<MlModelListResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/ml/models');
    return parseData(ModelListSchema, env);
  },

  /** POST /api/v1/ml/models/:id/promote — move a model to a new lifecycle stage. */
  promote: async (modelId: string, stage: MlModelStage): Promise<MlModel> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/ml/models/${encodeURIComponent(modelId)}/promote`,
      {
        method: 'POST',
        body: JSON.stringify({ stage }),
        idempotencyKey: generateRequestId(),
      },
    );
    return parseData(ModelSchema, env);
  },

  /** GET /api/v1/ml/customer-score?brain_id=… — serve a customer's RFM/churn score (honest no_data). */
  customerScore: async (brainId: string): Promise<MlCustomerScoreResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/ml/customer-score?brain_id=${encodeURIComponent(brainId)}`,
    );
    return parseData(CustomerScoreResultSchema, env);
  },
};
