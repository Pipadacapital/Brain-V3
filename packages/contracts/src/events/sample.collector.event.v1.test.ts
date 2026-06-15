/**
 * Contract test: CollectorEventV1Schema
 *
 * Validates that:
 * 1. A valid event parses successfully.
 * 2. Missing required fields are rejected.
 * 3. brand_id is always required (I-S01).
 * 4. correlation_id is always required (ADR-009).
 * 5. Properties default to {}.
 *
 * This is the "pact stub" that proves the pipeline is wired.
 * A breaking schema change (removing brand_id) MUST fail this test.
 */
import { describe, it, expect } from 'vitest';
import { CollectorEventV1Schema } from './sample.collector.event.v1.js';

const VALID_EVENT = {
  event_id: '11111111-1111-4111-8111-111111111111',
  brand_id: '22222222-2222-4222-8222-222222222222',
  correlation_id: 'trace-abc-123',
  event_name: 'page.viewed',
  occurred_at: '2026-06-15T12:00:00Z',
};

describe('CollectorEventV1Schema — contract tests', () => {
  it('parses a valid event', () => {
    const result = CollectorEventV1Schema.safeParse(VALID_EVENT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe('1');
      expect(result.data.properties).toEqual({});
    }
  });

  it('rejects an event without brand_id (I-S01 negative control)', () => {
    const { brand_id: _removed, ...withoutBrandId } = VALID_EVENT;
    const result = CollectorEventV1Schema.safeParse(withoutBrandId);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('brand_id');
    }
  });

  it('rejects an event without correlation_id (ADR-009 negative control)', () => {
    const { correlation_id: _removed, ...withoutCorr } = VALID_EVENT;
    const result = CollectorEventV1Schema.safeParse(withoutCorr);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('correlation_id');
    }
  });

  it('rejects an event without event_id', () => {
    const { event_id: _removed, ...withoutId } = VALID_EVENT;
    const result = CollectorEventV1Schema.safeParse(withoutId);
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID brand_id', () => {
    const result = CollectorEventV1Schema.safeParse({
      ...VALID_EVENT,
      brand_id: 'not-a-uuid',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-UUID event_id', () => {
    const result = CollectorEventV1Schema.safeParse({
      ...VALID_EVENT,
      event_id: 'bad-id',
    });
    expect(result.success).toBe(false);
  });

  it('accepts optional fields when provided', () => {
    const result = CollectorEventV1Schema.safeParse({
      ...VALID_EVENT,
      ingest_at: '2026-06-15T12:00:01Z',
      hashed_user_id: 'abc123',
      hashed_session_id: 'def456',
      properties: { page: 'home', ref: 'direct' },
    });
    expect(result.success).toBe(true);
  });

  it('defaults schema_version to "1"', () => {
    const result = CollectorEventV1Schema.safeParse(VALID_EVENT);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schema_version).toBe('1');
    }
  });
});
