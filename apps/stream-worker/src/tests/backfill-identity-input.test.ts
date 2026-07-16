/**
 * backfill-identity-input — pure unit tests for the GAP-A identity-backfill job's input normalization
 * (toResolveBuffer) and exit-code policy. No DB / Kafka / Neo4j — the live write path is exercised
 * operator-side per the GAP-A runbook (dry-run first), not in unit CI.
 *
 * Invariants under test:
 *   1. A keystone-shaped row (payload as a JSON STRING — the varchar export of
 *      brain_silver.silver_collector_event) is normalized so ResolveIdentityUseCase can extract
 *      payload.properties.* (a string payload would extract nothing → silent no_identifiers).
 *   2. An inline-object payload (full Bronze envelope) passes through unchanged.
 *   3. Rows execute() could never act on (missing brand_id/event_id, unparseable payload string)
 *      return null so the job counts them WITHOUT a resolver round-trip.
 *   4. Exit code is non-zero IFF any event errored (partial pass → operator re-runs; idempotent).
 */
import { describe, it, expect } from 'vitest';
import { toResolveBuffer, backfillExitCode } from '../jobs/identity/backfill-identity.js';

const BRAND = '8a431f62-2669-4560-9273-f49c8ee5addd';
const HEX64 = 'a'.repeat(64);

function parseBuf(buf: Buffer): Record<string, unknown> {
  return JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
}

describe('toResolveBuffer', () => {
  it('parses a STRING payload (keystone varchar export) into an object', () => {
    const row = {
      brand_id: BRAND,
      event_id: 'evt-1',
      payload: JSON.stringify({ properties: { hashed_customer_email: HEX64, order_id: 'o-1' } }),
    };
    const buf = toResolveBuffer(row);
    expect(buf).not.toBeNull();
    const out = parseBuf(buf!);
    const payload = out['payload'] as Record<string, unknown>;
    const props = payload['properties'] as Record<string, unknown>;
    expect(props['hashed_customer_email']).toBe(HEX64); // extractable by ResolveIdentityUseCase
  });

  it('passes an inline object payload through unchanged', () => {
    const row = {
      brand_id: BRAND,
      event_id: 'evt-2',
      payload: { properties: { storefront_customer_id: '8563036422450' } },
    };
    const out = parseBuf(toResolveBuffer(row)!);
    expect(out['payload']).toEqual(row.payload);
    expect(out['brand_id']).toBe(BRAND);
    expect(out['event_id']).toBe('evt-2');
  });

  it('returns null when brand_id or event_id is missing (execute() would reject anyway)', () => {
    expect(toResolveBuffer({ event_id: 'evt-3', payload: '{}' })).toBeNull();
    expect(toResolveBuffer({ brand_id: BRAND, payload: '{}' })).toBeNull();
  });

  it('returns null for an unparseable payload string (never feed the resolver garbage)', () => {
    expect(toResolveBuffer({ brand_id: BRAND, event_id: 'evt-4', payload: '{not json' })).toBeNull();
  });
});

describe('backfillExitCode', () => {
  const base = {
    brandId: BRAND, linesRead: 10, unparseable: 0, otherBrandRejected: 0,
    attempted: 10, outcomeCounts: {}, errors: 0, dryRun: false,
  };
  it('0 on a clean pass', () => {
    expect(backfillExitCode(base)).toBe(0);
  });
  it('non-zero when any event errored (partial pass — operator re-runs the same file)', () => {
    expect(backfillExitCode({ ...base, errors: 1 })).toBe(1);
  });
});
