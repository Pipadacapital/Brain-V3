// SPEC: B.4
/**
 * B.4 — Journey Replay (?as_of=) + Explainability. Acceptance B.5.3: a PRE-IDENTIFICATION as_of returns
 * the SHORTER anonymous-era journey. AMD-10 (R1): reconstruction from RETAINED version history
 * (`occurred_at <= as_of`) + identity_asof intervals — NOT Iceberg time-travel.
 *
 * The fake pool below HONORS the SQL semantics (occurred_at gate, keyset, ORDER/LIMIT) so the shorter-
 * journey assertion is a real behavioral test, not a stub. Serving ts strings 'YYYY-MM-DD HH:MM:SS'
 * compare lexicographically == chronologically.
 */
import { describe, it, expect } from 'vitest';
import {
  computeJourneyEventsAsOf,
  resolveIdentityAsOf,
  computeJourneyEventsCurrent,
} from './journey-events.js';
import type { SilverPool } from './silver-deps.js';

const BRAND = '33333333-3333-4333-8333-333333333333';
const BRAIN = '44444444-4444-4444-8444-444444444444';

interface Fixture {
  touchpoint_id: string;
  sequence_number: string;
  occurred_at: string;
  brain_id_asof: string | null;
  is_composite?: boolean;
}

/** A ledger DB row with the full column contract (mirrors mv_journey_events_current). */
function ledgerRow(f: Fixture): Record<string, unknown> {
  return {
    touchpoint_id: f.touchpoint_id,
    sequence_number: f.sequence_number,
    occurred_at: f.occurred_at,
    event_category: 'behaviour',
    event_type: 'page.viewed',
    channel: 'referral',
    campaign: null,
    revenue_minor: null,
    currency_code: null,
    is_composite: f.is_composite ?? false,
    identity_confidence: f.brain_id_asof ? 1 : null,
    data_version: 1,
    brain_id_asof: f.brain_id_asof,
    identity_confidence_asof: f.brain_id_asof ? 1 : null,
  };
}

/**
 * A fake Trino serving pool that SIMULATES the ledger read: it applies the `occurred_at <= ?` gate,
 * the `sequence_number < ?` keyset, and ORDER BY occurred_at DESC, sequence_number DESC + LIMIT. Params
 * arrive seam-substituted: [brainId, (asOfTs?), (after?), brandId] with ${BRAND_PREDICATE}→brand_id=?.
 */
function fakeLedgerPool(rows: Fixture[]): SilverPool & { lastSql: string; lastParams: unknown[] } {
  const pool = {
    lastSql: '',
    lastParams: [] as unknown[],
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
      pool.lastSql = sql;
      pool.lastParams = params;
      // Param order follows the WHERE clause: brainId first, then asOf (if gated), then after (if keyset).
      let i = 1; // params[0] = brainId
      const asOf = sql.includes('occurred_at <= ?') ? (params[i++] as string) : null;
      const after = sql.includes('sequence_number < ?') ? BigInt(params[i++] as string | number) : null;
      const limMatch = /LIMIT (\d+)/.exec(sql);
      const lim = limMatch ? Number(limMatch[1]) : rows.length;

      let out = rows.slice();
      if (asOf !== null) out = out.filter((r) => r.occurred_at <= asOf);
      if (after !== null) out = out.filter((r) => BigInt(r.sequence_number) < after);
      out.sort(
        (a, b) =>
          b.occurred_at.localeCompare(a.occurred_at) ||
          Number(BigInt(b.sequence_number) - BigInt(a.sequence_number)),
      );
      return out.slice(0, lim).map(ledgerRow) as T[];
    },
  };
  return pool;
}

// A canonical journey: 2 ANONYMOUS-era browse touches (before identification), then identification +
// 2 more touches (now owned by the resolved brain_id via merge). The full current ledger has 4 events.
const T_ANON_1 = '2026-07-01 09:00:00';
const T_ANON_2 = '2026-07-01 09:05:00';
const T_IDENTIFY = '2026-07-01 12:00:00'; // email captured → merge stitches the anon browse into BRAIN
const T_POST_1 = '2026-07-01 12:01:00';
const T_POST_2 = '2026-07-01 18:00:00';

const JOURNEY: Fixture[] = [
  { touchpoint_id: 'tp-1', sequence_number: '1', occurred_at: T_ANON_1, brain_id_asof: null },
  { touchpoint_id: 'tp-2', sequence_number: '2', occurred_at: T_ANON_2, brain_id_asof: null },
  { touchpoint_id: 'tp-3', sequence_number: '3', occurred_at: T_POST_1, brain_id_asof: BRAIN },
  { touchpoint_id: 'tp-4', sequence_number: '4', occurred_at: T_POST_2, brain_id_asof: BRAIN, is_composite: true },
];

describe('B.4 replay — computeJourneyEventsAsOf (version-history as-of, AMD-10 R1)', () => {
  it('B.5.3 — a PRE-identification as_of returns the SHORTER anonymous-era journey', async () => {
    const pool = fakeLedgerPool(JOURNEY);
    // Replay to a moment AFTER the anon browse but BEFORE identification (10:00).
    const preId = await computeJourneyEventsAsOf(BRAND, { srPool: pool }, {
      brainId: BRAIN,
      asOf: '2026-07-01T10:00:00Z',
    });
    expect(preId.hasData).toBe(true);
    // Only the 2 anonymous-era browse touches existed by then — SHORTER than the full 4-event journey.
    expect(preId.events.map((e) => e.touchpointId).sort()).toEqual(['tp-1', 'tp-2']);
    // Explainability: pre-identification events honestly carry matched_via='anonymous' + null brain_id_asof.
    for (const e of preId.events) {
      expect(e.matchedVia).toBe('anonymous');
      expect(e.brainIdAsof).toBeNull();
      expect(e.estimated).toBe(false);
    }
    // The SQL carried the replay temporal gate, brandId bound LAST.
    expect(pool.lastSql).toContain('occurred_at <= ?');
    expect(pool.lastParams[0]).toBe(BRAIN);
    expect(pool.lastParams[pool.lastParams.length - 1]).toBe(BRAND);
  });

  it('a POST-identification as_of returns the FULL journey (anon browse merged in)', async () => {
    const pool = fakeLedgerPool(JOURNEY);
    const postId = await computeJourneyEventsAsOf(BRAND, { srPool: pool }, {
      brainId: BRAIN,
      asOf: '2026-07-01T20:00:00Z',
    });
    expect(postId.events.map((e) => e.touchpointId).sort()).toEqual(['tp-1', 'tp-2', 'tp-3', 'tp-4']);
    // The composite transaction touch is explained as an order match.
    const composite = postId.events.find((e) => e.touchpointId === 'tp-4');
    expect(composite?.matchedVia).toBe('order');
    // A resolved touch is deterministic.
    const resolved = postId.events.find((e) => e.touchpointId === 'tp-3');
    expect(resolved?.matchedVia).toBe('deterministic');
  });

  it('the CURRENT projection (no as_of) is the FULL journey — replay is strictly a subset in time', async () => {
    const current = await computeJourneyEventsCurrent(BRAND, { srPool: fakeLedgerPool(JOURNEY) }, { brainId: BRAIN });
    expect(current.events).toHaveLength(4);
    const preId = await computeJourneyEventsAsOf(BRAND, { srPool: fakeLedgerPool(JOURNEY) }, {
      brainId: BRAIN,
      asOf: '2026-07-01T10:00:00Z',
    });
    expect(preId.events.length).toBeLessThan(current.events.length);
  });

  it('honest-empty: missing brainId or as_of never queries', async () => {
    const pool = fakeLedgerPool(JOURNEY);
    expect(await computeJourneyEventsAsOf(BRAND, { srPool: pool }, { brainId: '', asOf: '2026-07-01T10:00:00Z' })).toEqual({
      hasData: false, events: [], nextAfterSequence: null,
    });
    expect(await computeJourneyEventsAsOf(BRAND, { srPool: pool }, { brainId: BRAIN, asOf: '' })).toEqual({
      hasData: false, events: [], nextAfterSequence: null,
    });
  });

  it('keyset pagination composes with the as_of gate (look-ahead trim + next cursor)', async () => {
    const pool = fakeLedgerPool(JOURNEY);
    const p1 = await computeJourneyEventsAsOf(BRAND, { srPool: pool }, {
      brainId: BRAIN, asOf: '2026-07-01T20:00:00Z', limit: 2,
    });
    expect(p1.events.map((e) => e.sequenceNumber)).toEqual(['4', '3']); // newest-first
    expect(p1.nextAfterSequence).toBe('3');
    expect(pool.lastSql).toContain('LIMIT 3'); // limit+1 look-ahead
  });
});

describe('B.4 explainability — resolveIdentityAsOf (identity_asof intervals, WA-14)', () => {
  /** Fake pool returning identity_asof rows (already grouped by identifier_type). */
  function fakeIdentityPool(rows: Array<Record<string, unknown>>): SilverPool & { lastSql: string; lastParams: unknown[] } {
    const pool = {
      lastSql: '',
      lastParams: [] as unknown[],
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
        pool.lastSql = sql;
        pool.lastParams = params;
        return rows as T[];
      },
    };
    return pool;
  }

  it('identified=true with identity_evidence [{identifier_type, first_seen, source}]', async () => {
    const pool = fakeIdentityPool([
      { identifier_type: 'email', effective_from: T_IDENTIFY, confidence: 1 },
    ]);
    const state = await resolveIdentityAsOf(BRAND, { srPool: pool }, { brainId: BRAIN, asOf: '2026-07-01T20:00:00Z' });
    expect(state.identified).toBe(true);
    expect(state.evidence).toEqual([{ identifierType: 'email', firstSeen: T_IDENTIFY, source: 'identity_map' }]);
    // Reads the sanctioned bi-temporal accessor (WA-14), not the raw map; both axes pinned to as_of.
    expect(pool.lastSql).toContain('brain_serving.identity_asof');
    expect(pool.lastSql).toContain('system_from');
    expect(pool.lastParams[0]).toBe(BRAIN);
    expect(pool.lastParams[pool.lastParams.length - 1]).toBe(BRAND);
  });

  it('identified=false (still anonymous) when no interval is system-known at as_of', async () => {
    const state = await resolveIdentityAsOf(BRAND, { srPool: fakeIdentityPool([]) }, { brainId: BRAIN, asOf: '2026-07-01T10:00:00Z' });
    expect(state).toEqual({ identified: false, evidence: [] });
  });
});
