// AUD-IMPL-006: extracted VERBATIM from the former 2,640-line apps/web/lib/api/client.ts
// (per-domain decomposition mirroring the backend CQ-1 split). Import from '@/lib/api/client'
// — the index re-exports this module's public surface unchanged.
import {
  Customer360Schema,
  CustomerListSchema,
  VaultCoverageSchema,
  ErasureResultSchema,
  MergeReviewListSchema,
  MergeResolveResultSchema,
  UnmergeResultSchema,
} from '@brain/contracts';
import type {
  Customer360Response,
  CustomerListResponse,
  VaultCoverageResponse,
  ErasureResultResponse,
  MergeReviewListResponse,
  MergeResolveResultResponse,
  UnmergeResultResponse,
} from '../types';
import { bffFetch, parseData, type BffEnvelope } from './core';

/**
 * identityApi — identity control-plane reads (P0-C). Customer 360 is the first slice.
 */
export const identityApi = {
  /** GET /api/v1/identity/customers — paginated customer browse (counts only, never raw PII). */
  listCustomers: async (params: {
    lifecycle?: string;
    search?: string;
    /** Business (RFM/lifecycle) segment filter — VIP/loyal/at_risk/churned/first_time_buyer/window_shopper/… */
    segment?: string;
    /** Acquisition-SOURCE drilldown (P3) — first-touch source from gold_customer_360 (e.g. 'google'/'meta'/'direct'). */
    acquisitionSource?: string;
    limit?: number;
    offset?: number;
  }): Promise<CustomerListResponse> => {
    const qs = new URLSearchParams();
    if (params.lifecycle) qs.set('lifecycle', params.lifecycle);
    if (params.search && params.search.trim().length > 0) qs.set('search', params.search.trim());
    if (params.segment && params.segment.trim().length > 0) qs.set('segment', params.segment.trim());
    if (params.acquisitionSource && params.acquisitionSource.trim().length > 0)
      qs.set('acquisition_source', params.acquisitionSource.trim());
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    const q = qs.toString();
    const env = await bffFetch<BffEnvelope<unknown>>(`/v1/identity/customers${q ? `?${q}` : ''}`);
    return parseData(CustomerListSchema, env);
  },

  /** GET /api/v1/identity/customer?brain_id=<uuid> — resolved customer profile + links + merges. */
  getCustomer360: async (brainId: string): Promise<Customer360Response> => {
    const env = await bffFetch<BffEnvelope<unknown>>(
      `/v1/identity/customer?brain_id=${encodeURIComponent(brainId)}`,
    );
    return parseData(Customer360Schema, env);
  },

  /** GET /api/v1/identity/vault-coverage — counts-only PII vault coverage (never raw PII). */
  getVaultCoverage: async (): Promise<VaultCoverageResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/vault-coverage');
    return parseData(VaultCoverageSchema, env);
  },

  /** POST /api/v1/identity/customer/erase — DPDP right-to-deletion for one customer. */
  eraseCustomer: async (brainId: string): Promise<ErasureResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/customer/erase', {
      method: 'POST',
      body: JSON.stringify({ brain_id: brainId }),
    });
    return parseData(ErasureResultSchema, env);
  },

  /** GET /api/v1/identity/merge-reviews — pending merge candidates for the active brand. */
  listMergeReviews: async (): Promise<MergeReviewListResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/merge-reviews');
    return parseData(MergeReviewListSchema, env);
  },

  /** POST /api/v1/identity/merge-reviews/resolve — approve (merge) or reject a candidate. */
  resolveMergeReview: async (
    reviewId: string,
    decision: 'merge' | 'reject',
  ): Promise<MergeResolveResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/merge-reviews/resolve', {
      method: 'POST',
      body: JSON.stringify({ review_id: reviewId, decision }),
    });
    return parseData(MergeResolveResultSchema, env);
  },

  /** POST /api/v1/identity/customer/unmerge — split a merged customer back out. */
  unmergeCustomer: async (brainId: string): Promise<UnmergeResultResponse> => {
    const env = await bffFetch<BffEnvelope<unknown>>('/v1/identity/customer/unmerge', {
      method: 'POST',
      body: JSON.stringify({ brain_id: brainId }),
    });
    return parseData(UnmergeResultSchema, env);
  },
};
