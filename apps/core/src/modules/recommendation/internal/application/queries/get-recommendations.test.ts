import { describe, it, expect } from 'vitest';
import type { DbPool } from '@brain/db';
import { RecommendationsSchema } from '@brain/contracts';
import { getRecommendations, type RecommendationReadDeps } from './get-recommendations.js';

const BRAND = '44444444-4444-4444-8444-444444444444';
const CID = 'test-correlation';

/** Trusted brand gate → no confidence ceiling, no high-risk hold (keeps assertions on evidence). */
const GATE: RecommendationReadDeps['gate'] = { tier: 'trusted', blocksHighRiskRecommendation: false };

/** A fake RLS pool whose single client returns the configured recommendation rows. */
function fakePool(rows: Array<Record<string, unknown>>): DbPool {
  const client = {
    async query(): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number }> {
      return { rows, rowCount: rows.length };
    },
    release(): void {},
  };
  return {
    async connect() {
      return client as never;
    },
  } as unknown as DbPool;
}

function row(evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    recommendation_id: 'rec-1',
    detector: 'revenue_trend',
    kind: 'risk',
    confidence: 'Trusted',
    priority: 1,
    status: 'open',
    payload: {
      title: 'Revenue down',
      summary: 'why',
      recommended_action: 'do this',
      evidence,
    },
    outcome: null,
    created_at: new Date('2026-07-11T00:00:00.000Z'),
  };
}

describe('getRecommendations — evidence sanitization (BFF contract drift fix)', () => {
  it('strips null/undefined evidence values, keeping string|number|boolean', async () => {
    const deps: RecommendationReadDeps = {
      pool: fakePool([
        row({
          current_minor: '82000',
          prior_minor: '100000',
          top_driver_event: null, // the exact prod bug: a persisted null value
          missing: undefined,
          count: 5,
          flagged: true,
        }),
      ]),
      gate: GATE,
    };

    const res = await getRecommendations(BRAND, CID, deps);
    expect(res.state).toBe('has_data');
    if (res.state !== 'has_data') return;
    const ev = res.recommendations[0]!.evidence;

    // null/undefined stripped …
    expect('top_driver_event' in ev).toBe(false);
    expect('missing' in ev).toBe(false);
    // … valid values kept, with type preserved.
    expect(ev.current_minor).toBe('82000');
    expect(ev.prior_minor).toBe('100000');
    expect(ev.count).toBe(5);
    expect(ev.flagged).toBe(true);
  });

  it('produces evidence that parses against the @brain/contracts RecommendationsSchema', async () => {
    const deps: RecommendationReadDeps = {
      pool: fakePool([row({ current_minor: '1', top_driver_event: null })]),
      gate: GATE,
    };
    const res = await getRecommendations(BRAND, CID, deps);
    // Before the fix, the persisted null would make this parse throw
    // "Invalid input at recommendations.0.evidence.top_driver_event".
    expect(() => RecommendationsSchema.parse(res)).not.toThrow();
  });

  it('tolerates a null/absent payload.evidence (defaults to {})', async () => {
    const bad = row({});
    (bad.payload as Record<string, unknown>).evidence = null;
    const res = await getRecommendations(BRAND, CID, { pool: fakePool([bad]), gate: GATE });
    if (res.state !== 'has_data') throw new Error('expected has_data');
    expect(res.recommendations[0]!.evidence).toEqual({});
  });
});
