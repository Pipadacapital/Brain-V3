/**
 * materializeInsightsAsRecommendations — the insight→recommendation closed-loop bridge.
 * Verifies: upsert per insight, trend→opportunity mapping, decision_log ONLY on first raise
 * (read-through refresh doesn't re-log or reset a dismissal), and the returned id/status mapping.
 */
import { describe, it, expect, vi } from 'vitest';
import { materializeInsightsAsRecommendations, type InsightForRecommendation } from './materialize-insights.js';

function insight(over: Partial<InsightForRecommendation> = {}): InsightForRecommendation {
  return {
    id: 'rto_leakage:INR', detector: 'rto_leakage', kind: 'risk', severity: 'high',
    title: 'RTO leakage', why: 'why', recommended_action: 'do it',
    currency_code: 'INR', impact_minor: '400000000', delta_pct: null, direction: null,
    confidence: 'high', evidence: { rate: '0.16' }, ...over,
  };
}

/** Mock DbPool: capture every (sql, params); recommendation upsert returns the given inserted flag. */
function mockPool(insertedFlags: boolean[]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let upsertIdx = 0;
  const client = {
    query: vi.fn(async (_ctx: unknown, sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO recommendation')) {
        const inserted = insertedFlags[upsertIdx++] ?? true;
        return { rows: [{ recommendation_id: `rec-${upsertIdx}`, status: 'open', inserted }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 }; // decision_log insert
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client };
}

describe('materializeInsightsAsRecommendations', () => {
  it('upserts each insight and logs a decision ONLY on first raise', async () => {
    const { pool, calls } = mockPool([true, false]); // first inserted, second already existed
    const out = await materializeInsightsAsRecommendations('brand-1', [insight(), insight({ id: 'cac_trend:INR', detector: 'cac_trend' })], 'corr', { pool });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ insightId: 'rto_leakage:INR', status: 'open' });
    const upserts = calls.filter((c) => c.sql.includes('INSERT INTO recommendation'));
    const logs = calls.filter((c) => c.sql.includes('INSERT INTO decision_log'));
    expect(upserts).toHaveLength(2);
    expect(logs).toHaveLength(1); // only the inserted=true one logs (no spam on read-through refresh)
  });

  it('maps a positive trend to kind=opportunity (recommendation CHECK allows risk|opportunity)', async () => {
    const { pool, calls } = mockPool([true]);
    await materializeInsightsAsRecommendations('brand-1', [insight({ id: 'revenue_trend:INR', detector: 'revenue_trend', kind: 'trend' })], 'corr', { pool });
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO recommendation'))!;
    // params: [brandId, detector, subject, kind, confidence, priority, payload]
    expect(upsert.params[3]).toBe('opportunity');
  });

  it('does NOT reset status / re-log when the rec already exists (dismissal preserved)', async () => {
    const { pool, calls } = mockPool([false]);
    await materializeInsightsAsRecommendations('brand-1', [insight()], 'corr', { pool });
    expect(calls.filter((c) => c.sql.includes('INSERT INTO decision_log'))).toHaveLength(0);
    // the upsert SQL must NOT reset status on conflict (read-through safety).
    const upsert = calls.find((c) => c.sql.includes('INSERT INTO recommendation'))!;
    expect(upsert.sql).not.toMatch(/SET[\s\S]*status\s*=/i);
  });
});
