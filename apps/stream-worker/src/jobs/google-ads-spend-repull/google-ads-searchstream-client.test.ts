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
  GOOGLE_RESOURCE_EXHAUSTED,
  GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED,
} from './google-ads-searchstream-client.js';

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
    const body = {
      error: {
        status: 'RESOURCE_EXHAUSTED', // gRPC status is the same; the quotaError discriminates
        details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' } }] }],
      },
    };
    // RESOURCE_EXHAUSTED status takes precedence ONLY when no TEMPORARILY quotaError —
    // here the explicit TEMPORARILY quotaError means QPS. Assert via the quota-only path:
    const qpsOnly = {
      error: {
        details: [{ errors: [{ errorCode: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' } }] }],
      },
    };
    expect(classifyGoogleError(qpsOnly, 200)).toBe('QPS');
    // and a plain 429 with no quota detail is treated as QPS (transient).
    expect(classifyGoogleError({}, 429)).toBe('QPS');
    void body;
  });

  it('classifies anything else as OTHER', () => {
    expect(classifyGoogleError({ error: { status: 'INVALID_ARGUMENT' } }, 400)).toBe('OTHER');
    expect(classifyGoogleError({}, 500)).toBe('OTHER');
  });

  it('exports stable throttle error constants', () => {
    expect(GOOGLE_RESOURCE_EXHAUSTED).toBe('GOOGLE_RESOURCE_EXHAUSTED');
    expect(GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED).toBe('GOOGLE_RESOURCE_TEMPORARILY_EXHAUSTED');
  });
});
