/**
 * audit-hash-chain.test.ts — tamper-evidence of the audit hash-chain (R-19 / L-02).
 *
 * Regression for a real defect: the previous canonicalization passed the top-level key
 * array as JSON.stringify's second argument — an allowlist FILTER, not a key-sorter. It
 * applied recursively, so the entire nested `payload` was stripped from the hashed bytes
 * and payload tampering produced an IDENTICAL entry_hash (the chain was not tamper-evident
 * on the one field that carries the sensitive content). These tests pin the fix.
 */
import { describe, it, expect } from 'vitest';
import { canonicalize, computeEntryHash, type AuditEntry } from './index.js';

type HashableEntry = Omit<AuditEntry, 'idempotency_key'>;

const baseEntry: HashableEntry = {
  brand_id: '11111111-1111-4111-8111-111111111111',
  actor_id: null,
  actor_role: 'system',
  action: 'pixel.brand_mismatch',
  entity_type: 'collector_event',
  entity_id: 'evt-1',
  payload: {
    claimed_brand_id: 'EVIL',
    derived_brand_id: 'real',
    correlation_id: 'corr-1',
    outcome: 'quarantined',
  },
};

describe('canonicalize — deterministic, full-coverage', () => {
  it('covers the full nested payload (not stripped to {})', () => {
    const c = canonicalize(baseEntry);
    expect(c).toContain('"claimed_brand_id":"EVIL"');
    expect(c).toContain('"outcome":"quarantined"');
    expect(c).not.toContain('"payload":{}');
  });

  it('is independent of key-insertion order at every depth', () => {
    const reordered: HashableEntry = {
      entity_id: 'evt-1',
      action: 'pixel.brand_mismatch',
      payload: {
        outcome: 'quarantined',
        correlation_id: 'corr-1',
        derived_brand_id: 'real',
        claimed_brand_id: 'EVIL',
      },
      entity_type: 'collector_event',
      actor_role: 'system',
      actor_id: null,
      brand_id: '11111111-1111-4111-8111-111111111111',
    };
    expect(canonicalize(reordered)).toBe(canonicalize(baseEntry));
  });

  it('sorts nested object keys and preserves array order', () => {
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(canonicalize({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
  });

  it('omits undefined object members (JSON semantics), keeps null', () => {
    expect(canonicalize({ a: undefined, b: null, c: 1 })).toBe('{"b":null,"c":1}');
  });
});

describe('computeEntryHash — tamper-evidence', () => {
  it('DETECTS a payload tamper (the core regression)', () => {
    const honest = computeEntryHash(null, baseEntry);
    const tampered = computeEntryHash(null, {
      ...baseEntry,
      payload: { ...baseEntry.payload, claimed_brand_id: 'NICE' },
    });
    expect(tampered).not.toBe(honest);
  });

  it('is stable across key-insertion order (same logical row → same hash)', () => {
    const reordered: HashableEntry = {
      payload: {
        outcome: 'quarantined',
        correlation_id: 'corr-1',
        derived_brand_id: 'real',
        claimed_brand_id: 'EVIL',
      },
      entity_id: 'evt-1',
      entity_type: 'collector_event',
      action: 'pixel.brand_mismatch',
      actor_role: 'system',
      actor_id: null,
      brand_id: '11111111-1111-4111-8111-111111111111',
    };
    expect(computeEntryHash(null, reordered)).toBe(computeEntryHash(null, baseEntry));
  });

  it('chains: entry_hash depends on prev_hash (a reorder/insert breaks the link)', () => {
    const genesis = computeEntryHash(null, baseEntry);
    const second = computeEntryHash(genesis, { ...baseEntry, entity_id: 'evt-2' });
    const secondUnlinked = computeEntryHash('genesis', { ...baseEntry, entity_id: 'evt-2' });
    expect(second).not.toBe(secondUnlinked);
  });

  it('produces a 64-hex sha256 digest', () => {
    expect(computeEntryHash(null, baseEntry)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('detects a tamper in any top-level field too', () => {
    const honest = computeEntryHash(null, baseEntry);
    expect(computeEntryHash(null, { ...baseEntry, actor_role: 'owner' })).not.toBe(honest);
    expect(computeEntryHash(null, { ...baseEntry, action: 'pixel.ok' })).not.toBe(honest);
  });
});
