/**
 * list-customers keyset cursor — unit tests (serving-layer Gap 4).
 *
 * Exercises the opaque-cursor codec + the cursor plumbing through listCustomers with a fake
 * IdentityReader (no Neo4j). Verifies:
 *   1. codec round-trip; invalid/garbage cursors decode to null (browse never hard-fails);
 *   2. a full page yields next_cursor keyed on the LAST row; a short page yields null;
 *   3. a request cursor is decoded and passed to the reader as `after` (offset ignored);
 *   4. an invalid request cursor degrades to offset paging (after=null);
 *   5. last row without created_at → next_cursor null (cannot keyset past it).
 */
import { describe, expect, it } from 'vitest';
import {
  listCustomers,
  encodeCustomerListCursor,
  decodeCustomerListCursor,
} from '../internal/application/queries/list-customers.js';
import type { CustomerListRow, IdentityReader } from '../internal/infrastructure/neo4j-identity-reader.js';

const BRAND = 'aaaa0000-0000-4000-8000-aaaaaaaaaaaa';

function row(brainId: string, createdAt: Date | null): CustomerListRow {
  return {
    brain_id: brainId,
    anonymous_id: null,
    lifecycle_state: 'active',
    merged_into: null,
    ai_processing_consent: false,
    resolution_consent: true,
    identifier_count: 1,
    last_identifier_at: null,
    created_at: createdAt,
  };
}

/** Fake reader capturing the opts listCustomers passes down. */
function makeFakeReader(items: CustomerListRow[], total: number) {
  const captured: { after?: { createdAtMs: number; brainId: string } | null; offset?: number } = {};
  const reader = {
    listCustomers: async (_brandId: string, opts: { offset: number; after?: { createdAtMs: number; brainId: string } | null }) => {
      captured.after = opts.after;
      captured.offset = opts.offset;
      return { items, total };
    },
  } as unknown as IdentityReader;
  return { reader, captured };
}

describe('customer-list cursor codec', () => {
  it('round-trips (created_at ms, brain_id)', () => {
    const encoded = encodeCustomerListCursor(1_750_000_000_000, 'brain-x');
    const decoded = decodeCustomerListCursor(encoded);
    expect(decoded).toEqual({ v: 1, ca: 1_750_000_000_000, id: 'brain-x' });
  });

  it('garbage / foreign cursors decode to null', () => {
    expect(decodeCustomerListCursor('not-base64-json')).toBeNull();
    expect(decodeCustomerListCursor(Buffer.from('{"v":2,"ca":1,"id":"x"}').toString('base64url'))).toBeNull();
    expect(decodeCustomerListCursor(Buffer.from('{"v":1,"ca":"NaN","id":"x"}').toString('base64url'))).toBeNull();
    expect(decodeCustomerListCursor(Buffer.from('{"v":1,"ca":1,"id":""}').toString('base64url'))).toBeNull();
    expect(decodeCustomerListCursor('')).toBeNull();
  });
});

describe('listCustomers — cursor pagination', () => {
  it('a FULL page returns next_cursor keyed on the last row', async () => {
    const t1 = new Date('2026-07-01T10:00:00Z');
    const t2 = new Date('2026-07-01T09:00:00Z');
    const { reader } = makeFakeReader([row('b1', t1), row('b2', t2)], 10);
    const result = await listCustomers(BRAND, { limit: 2, offset: 0 }, 'corr', { reader });
    expect(result.next_cursor).not.toBeNull();
    expect(decodeCustomerListCursor(result.next_cursor!)).toEqual({ v: 1, ca: t2.getTime(), id: 'b2' });
  });

  it('a SHORT page (last page) returns next_cursor null', async () => {
    const { reader } = makeFakeReader([row('b1', new Date())], 1);
    const result = await listCustomers(BRAND, { limit: 25, offset: 0 }, 'corr', { reader });
    expect(result.next_cursor).toBeNull();
  });

  it('last row without created_at → next_cursor null (cannot keyset past it)', async () => {
    const { reader } = makeFakeReader([row('b1', new Date()), row('b2', null)], 10);
    const result = await listCustomers(BRAND, { limit: 2, offset: 0 }, 'corr', { reader });
    expect(result.next_cursor).toBeNull();
  });

  it('a request cursor is decoded and passed to the reader as `after` (offset ignored)', async () => {
    const { reader, captured } = makeFakeReader([], 0);
    const cursor = encodeCustomerListCursor(1_750_000_000_000, 'b9');
    await listCustomers(BRAND, { limit: 25, offset: 50, cursor }, 'corr', { reader });
    expect(captured.after).toEqual({ createdAtMs: 1_750_000_000_000, brainId: 'b9' });
  });

  it('an INVALID request cursor degrades to offset paging (after=null)', async () => {
    const { reader, captured } = makeFakeReader([], 0);
    await listCustomers(BRAND, { limit: 25, offset: 50, cursor: '!!bogus!!' }, 'corr', { reader });
    expect(captured.after).toBeNull();
    expect(captured.offset).toBe(50);
  });
});
