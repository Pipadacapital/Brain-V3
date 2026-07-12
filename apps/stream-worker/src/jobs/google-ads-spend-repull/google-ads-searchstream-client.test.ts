/**
 * google-ads-searchstream-client unit tests — the ADR-AD-7 two-error throttle branch.
 *
 * Pure unit tests of classifyGoogleError (the error mapping that drives the run.ts branch):
 *   RESOURCE_EXHAUSTED            → 'DAILY' (abort run, no in-run retry)
 *   RESOURCE_TEMPORARILY_EXHAUSTED → 'QPS'  (bounded backoff then continue)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyGoogleError,
  extractGoogleErrorDetail,
  FIREHOSE_RESOURCE_NAMES,
  GOOGLE_RESOURCE_EXHAUSTED,
  GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED,
  GOOGLE_ACCOUNT_DISABLED,
} from './google-ads-searchstream-client.js';
import { GOOGLE_ADS_INGESTION_MANIFEST } from '@brain/connector-core';

describe('classifyGoogleError (ADR-AD-7 two-error branch)', () => {
  it('classifies RESOURCE_EXHAUSTED (daily ops-quota) as DAILY → abort run', () => {
    const body = {
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_EXHAUSTED' } }] }],
      },
    };
    expect(classifyGoogleError(body, 429)).toBe('DAILY');
  });

  it('classifies RESOURCE_TEMPORARILY_EXHAUSTED (QPS) as QPS → bounded backoff', () => {
    // Q-CURSOR regression: the QPS throttle arrives inside a gRPC RESOURCE_EXHAUSTED
    // envelope; the explicit TEMPORARILY quotaError discriminates it as QPS. The
    // classifier MUST NOT abort the day's repull here. This is the exact mixed-field
    // case that previously dodged assertion via `void body`.
    const mixedField = {
      error: {
        status: 'RESOURCE_EXHAUSTED', // gRPC status is the same; the quotaError discriminates
        details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' } }] }],
      },
    };
    expect(classifyGoogleError(mixedField, 429)).toBe('QPS');
    expect(classifyGoogleError(mixedField, 200)).toBe('QPS');
    // quota-only (no gRPC status) path also resolves to QPS.
    const qpsOnly = {
      error: {
        details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' } }] }],
      },
    };
    expect(classifyGoogleError(qpsOnly, 200)).toBe('QPS');
    // and a plain 429 with no quota detail is treated as QPS (transient).
    expect(classifyGoogleError({}, 429)).toBe('QPS');
  });

  it('classifies anything else as OTHER', () => {
    expect(classifyGoogleError({ error: { status: 'INVALID_ARGUMENT' } }, 400)).toBe('OTHER');
    expect(classifyGoogleError({}, 500)).toBe('OTHER');
  });

  it('classifies CUSTOMER_NOT_ENABLED (deactivated account) as ACCOUNT_DISABLED → back off', () => {
    const disabled = {
      error: {
        status: 'PERMISSION_DENIED',
        details: [{ errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' }, message: 'The customer account is not enabled.' }] }],
      },
    };
    expect(classifyGoogleError(disabled, 403)).toBe('ACCOUNT_DISABLED');
    // CUSTOMER_NOT_FOUND + USER_PERMISSION_DENIED also map to ACCOUNT_DISABLED (account unusable).
    expect(classifyGoogleError(
      { error: { details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }, 403,
    )).toBe('ACCOUNT_DISABLED');
  });

  it('extractGoogleErrorDetail flattens the first error code + message (C5-safe, no raw body)', () => {
    const body = {
      error: {
        status: 'PERMISSION_DENIED',
        details: [{ errors: [{ errorCode: { authorizationError: 'CUSTOMER_NOT_ENABLED' }, message: 'not enabled' }] }],
      },
    };
    expect(extractGoogleErrorDetail(body)).toEqual({ code: 'CUSTOMER_NOT_ENABLED', message: 'not enabled' });
    // empty body → nulls (no throw).
    expect(extractGoogleErrorDetail({})).toEqual({ code: null, message: null });
  });

  it('exports stable throttle + account-disabled error constants', () => {
    expect(GOOGLE_RESOURCE_EXHAUSTED).toBe('GOOGLE_RESOURCE_EXHAUSTED');
    expect(GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED).toBe('GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED');
    expect(GOOGLE_ACCOUNT_DISABLED).toBe('GOOGLE_ACCOUNT_DISABLED');
  });
});

// ── FIREHOSE — client views ↔ manifest resources consistency (no orphaned resource) ──────────────
describe('google firehose resource ↔ manifest consistency', () => {
  it('every backfillable manifest resource (except base spend) has a client GAQL query template', () => {
    const backfillable = GOOGLE_ADS_INGESTION_MANIFEST.resources
      .filter((r) => r.backfillSupported && r.name !== 'spend')
      .map((r) => r.name)
      .sort();
    const clientViews = [...FIREHOSE_RESOURCE_NAMES].sort();
    expect(clientViews).toEqual(backfillable);
  });

  it('click_view manifest resource is capped at 90 days (API limit), the rest at 2 years', () => {
    const click = GOOGLE_ADS_INGESTION_MANIFEST.resources.find((r) => r.name === 'click');
    expect(click).toBeDefined();
    expect(click!.maxBackfillWindowMs).toBe(90 * 24 * 60 * 60 * 1000);
    const keyword = GOOGLE_ADS_INGESTION_MANIFEST.resources.find((r) => r.name === 'keyword');
    expect(keyword!.maxBackfillWindowMs).toBe(2 * 365 * 24 * 60 * 60 * 1000);
  });
});
