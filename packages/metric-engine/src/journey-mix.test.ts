/**
 * journey-mix.test.ts — unit tests for the journey seam (Silver touchpoint).
 *
 * Tests the pure folds (DISTINCT counts + integer share math + honest no_data +
 * deterministic channel mapping + timeline projection) by mocking the Silver seam
 * (withSilverBrand) with a pass-through that hands `fn` a SilverScope whose runScoped
 * returns fixture rows. No StarRocks required (the live read seam is proven non-inert in
 * tools/isolation-fuzz/src/silver-touchpoint.test.ts).
 *
 * SPEC-DERIVED LITERALS only — every assertion is a concrete value derived from the
 * fixture, not a tautology. Share/hit-rate values are hand-computed basis points.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock the Silver seam BEFORE importing the module under test ──────────────
vi.mock('./silver-deps.js', async () => {
  const actual = await vi.importActual<typeof import('./silver-deps.js')>('./silver-deps.js');
  return {
    ...actual, // keep BRAND_PREDICATE etc.
    withSilverBrand: vi.fn(),
  };
});

// The orderId timeline path resolves order → stitched anon(s) from the PG-native stitch map via
// withBrandTxn (Brain V4 — the stitch map is PG operational state, not on the Trino serving tier).
vi.mock('./deps.js', async () => {
  const actual = await vi.importActual<typeof import('./deps.js')>('./deps.js');
  return {
    ...actual,
    withBrandTxn: vi.fn(),
  };
});

import {
  computeFirstTouchMix,
  computeStitchHitRate,
  computeTouchpointTimeline,
} from './journey-mix.js';
import { withSilverBrand } from './silver-deps.js';
import { withBrandTxn } from './deps.js';

const withSilverBrandMock = vi.mocked(withSilverBrand);
const withBrandTxnMock = vi.mocked(withBrandTxn);

/** Wire withBrandTxn to resolve an order → the given stitched anon ids (PG stitch-map read). */
function setupStitchAnons(anonIds: string[]) {
  withBrandTxnMock.mockImplementation(async (_pool, _brandId, fn) => {
    const client = { query: async () => ({ rows: anonIds.map((a) => ({ stitched_anon_id: a })) }) };
    return fn(client as never);
  });
}

const BRAND_ID = '00000000-0000-0000-0000-000000000001';
const fakeDeps = { srPool: {} as never };
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-18T23:59:59Z') };

/** Wire withSilverBrand to call fn with a scope whose runScoped returns the fixture rows. */
function setupRows(rows: unknown[]) {
  withSilverBrandMock.mockImplementation(async (_pool, _brandId, fn) => {
    const scope = { runScoped: vi.fn(async () => rows) };
    return fn(scope as never);
  });
}

/** Capture the brandId actually passed into the seam (tenant-scope assertion). */
function captureBrand(rows: unknown[]): { brandId: string | undefined } {
  const captured: { brandId: string | undefined } = { brandId: undefined };
  withSilverBrandMock.mockImplementation(async (_pool, brandId, fn) => {
    captured.brandId = brandId;
    const scope = { runScoped: vi.fn(async () => rows) };
    return fn(scope as never);
  });
  return captured;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── computeFirstTouchMix ─────────────────────────────────────────────────────
describe('computeFirstTouchMix — first-touch channel mix fold', () => {

  it('hasData=false when the brand has zero touchpoints in the window (honest no_data)', async () => {
    setupRows([]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.hasData).toBe(false);
    expect(result.total).toBe(0n);
    expect(result.byChannel).toEqual([]);
  });

  it('counts + total are exact bigints over the grouped channels', async () => {
    // paid_meta=40, email=10, direct=50 → total=100
    setupRows([
      { channel: 'paid_meta', cnt: '40' },
      { channel: 'email',     cnt: '10' },
      { channel: 'direct',    cnt: '50' },
    ]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.hasData).toBe(true);
    expect(result.total).toBe(100n);
    expect(typeof result.total).toBe('bigint');
    expect(result.byChannel.find((b) => b.channel === 'paid_meta')?.count).toBe(40n);
    expect(result.byChannel.find((b) => b.channel === 'email')?.count).toBe(10n);
    expect(result.byChannel.find((b) => b.channel === 'direct')?.count).toBe(50n);
  });

  it('share percentages are exact 2dp integer-math strings (no float)', async () => {
    // total = 100 → paid_meta 40/100=40.00; email 10/100=10.00; direct 50/100=50.00
    setupRows([
      { channel: 'paid_meta', cnt: '40' },
      { channel: 'email',     cnt: '10' },
      { channel: 'direct',    cnt: '50' },
    ]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.byChannel.find((b) => b.channel === 'paid_meta')?.sharePct).toBe('40.00');
    expect(result.byChannel.find((b) => b.channel === 'email')?.sharePct).toBe('10.00');
    expect(result.byChannel.find((b) => b.channel === 'direct')?.sharePct).toBe('50.00');
  });

  it('share with a non-round ratio truncates to 2dp via basis points', async () => {
    // total = 3 → each 1/3: bps = (1*10000)/3 = 3333 → '33.33'
    setupRows([
      { channel: 'paid_google', cnt: '1' },
      { channel: 'referral',    cnt: '1' },
      { channel: 'direct',      cnt: '1' },
    ]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.total).toBe(3n);
    for (const b of result.byChannel) expect(b.sharePct).toBe('33.33');
  });

  it('first-touch is attributed to the RIGHT channel (paid_meta carries its own count)', async () => {
    // Spec: a journey whose first touch carries fbclid → paid_meta in dbt; here the mart
    // already emits channel='paid_meta'. The fold must keep that channel's count distinct.
    setupRows([
      { channel: 'paid_meta',   cnt: '7' },
      { channel: 'paid_google', cnt: '3' },
    ]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.total).toBe(10n);
    expect(result.byChannel.find((b) => b.channel === 'paid_meta')?.count).toBe(7n);
    expect(result.byChannel.find((b) => b.channel === 'paid_google')?.count).toBe(3n);
    // 7/10 = 70.00, 3/10 = 30.00
    expect(result.byChannel.find((b) => b.channel === 'paid_meta')?.sharePct).toBe('70.00');
    expect(result.byChannel.find((b) => b.channel === 'paid_google')?.sharePct).toBe('30.00');
  });

  it('emits channels in canonical order (paid_meta→…→direct)', async () => {
    // Provide rows out of order; output must be canonical.
    setupRows([
      { channel: 'direct',    cnt: '1' },
      { channel: 'paid_meta', cnt: '1' },
      { channel: 'referral',  cnt: '1' },
    ]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    expect(result.byChannel.map((b) => b.channel)).toEqual(['paid_meta', 'referral', 'direct']);
  });

  it('an unknown channel string folds deterministically to direct (honest, never invented)', async () => {
    // A mart row with an unexpected channel must not crash and must not invent a bucket.
    setupRows([
      { channel: 'something_new', cnt: '2' },
      { channel: 'direct',        cnt: '3' },
    ]);
    const result = await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);

    // 2 (unknown→direct) + 3 (direct) = 5 in the direct bucket; total still 5.
    expect(result.total).toBe(5n);
    expect(result.byChannel).toHaveLength(1);
    expect(result.byChannel[0]?.channel).toBe('direct');
    expect(result.byChannel[0]?.count).toBe(5n);
  });

  it('reads through the seam with the SESSION brandId (tenant-scoped; D-1)', async () => {
    const captured = captureBrand([{ channel: 'direct', cnt: '1' }]);
    await computeFirstTouchMix(BRAND_ID, fakeDeps, RANGE);
    expect(captured.brandId).toBe(BRAND_ID);
  });
});

// ── computeStitchHitRate ─────────────────────────────────────────────────────
describe('computeStitchHitRate — deterministic cart-stitch hit-rate', () => {

  it('hasData=false + null hitPct when total=0 (honest no_data, no divide-by-zero)', async () => {
    setupRows([{ stitched: '0', total: '0' }]);
    const result = await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);

    expect(result.hasData).toBe(false);
    expect(result.total).toBe(0n);
    expect(result.stitched).toBe(0n);
    expect(result.hitPct).toBe(null);
  });

  it('hasData=false when the seam returns no aggregate row at all', async () => {
    setupRows([]);
    const result = await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);
    expect(result.hasData).toBe(false);
    expect(result.hitPct).toBe(null);
  });

  it('hit-rate math: 30 stitched of 120 total = 25.00% (integer basis points)', async () => {
    // bps = (30*10000)/120 = 2500 → '25.00'
    setupRows([{ stitched: '30', total: '120' }]);
    const result = await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);

    expect(result.hasData).toBe(true);
    expect(result.total).toBe(120n);
    expect(result.stitched).toBe(30n);
    expect(typeof result.total).toBe('bigint');
    expect(result.hitPct).toBe('25.00');
  });

  it('hit-rate math: 1 stitched of 3 total truncates to 33.33% (no float)', async () => {
    // bps = (1*10000)/3 = 3333 → '33.33'
    setupRows([{ stitched: '1', total: '3' }]);
    const result = await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);
    expect(result.hitPct).toBe('33.33');
  });

  it('100% hit-rate when every journey stitched (7 of 7 = 100.00)', async () => {
    setupRows([{ stitched: '7', total: '7' }]);
    const result = await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);
    expect(result.hitPct).toBe('100.00');
    expect(result.stitched).toBe(7n);
  });

  it('0% hit-rate is honest (0 stitched of 5 = 0.00, NOT no_data)', async () => {
    setupRows([{ stitched: '0', total: '5' }]);
    const result = await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);
    expect(result.hasData).toBe(true);
    expect(result.hitPct).toBe('0.00');
  });

  it('reads through the seam with the SESSION brandId (tenant-scoped; D-1)', async () => {
    const captured = captureBrand([{ stitched: '1', total: '2' }]);
    await computeStitchHitRate(BRAND_ID, fakeDeps, RANGE);
    expect(captured.brandId).toBe(BRAND_ID);
  });
});

// ── computeTouchpointTimeline ────────────────────────────────────────────────
describe('computeTouchpointTimeline — ordered touch projection for one journey', () => {

  const TOUCH_ROWS = [
    {
      brain_anon_id: 'anon-x', touch_seq: 1, is_first_touch: 1, is_last_touch: 0,
      occurred_at: '2026-06-10 09:00:00', channel: 'paid_meta',
      utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'spring', utm_term: null, utm_content: null,
      fbclid: 'fb123', gclid: null, ttclid: null, referrer_host: null, landing_path: '/lp',
      stitched_brain_id: 'brain-9', event_type: 'page.viewed',
    },
    {
      brain_anon_id: 'anon-x', touch_seq: 2, is_first_touch: 0, is_last_touch: 1,
      occurred_at: '2026-06-10 09:20:00', channel: 'direct',
      utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null,
      fbclid: null, gclid: null, ttclid: null, referrer_host: null, landing_path: '/cart',
      stitched_brain_id: 'brain-9', event_type: 'cart.viewed',
    },
  ];

  it('hasData=false on an unknown journey (honest no_data)', async () => {
    setupRows([]);
    const result = await computeTouchpointTimeline(BRAND_ID, fakeDeps, { brainAnonId: 'nope' });
    expect(result.hasData).toBe(false);
    expect(result.brainAnonId).toBe(null);
    expect(result.touches).toEqual([]);
    expect(result.stitched).toBe(false);
  });

  it('projects the ordered touches with first/last flags + channel (by brainAnonId)', async () => {
    setupRows(TOUCH_ROWS);
    const result = await computeTouchpointTimeline(BRAND_ID, fakeDeps, { brainAnonId: 'anon-x' });

    expect(result.hasData).toBe(true);
    expect(result.brainAnonId).toBe('anon-x');
    expect(result.touches).toHaveLength(2);
    expect(result.touches[0]?.touchSeq).toBe(1);
    expect(result.touches[0]?.isFirstTouch).toBe(true);
    expect(result.touches[0]?.isLastTouch).toBe(false);
    expect(result.touches[0]?.channel).toBe('paid_meta');
    expect(result.touches[0]?.utmSource).toBe('facebook');
    expect(result.touches[0]?.fbclid).toBe('fb123');
    expect(result.touches[0]?.gclid).toBe(null);
    expect(result.touches[1]?.touchSeq).toBe(2);
    expect(result.touches[1]?.isLastTouch).toBe(true);
    expect(result.touches[1]?.channel).toBe('direct');
  });

  it('stitched=true when any touch carries a stitched_brain_id (deterministic read-back)', async () => {
    setupStitchAnons(['anon-x']); // order-1 → anon-x via the PG stitch map
    setupRows(TOUCH_ROWS);
    const result = await computeTouchpointTimeline(BRAND_ID, { srPool: {} as never, pool: {} as never }, { orderId: 'order-1' });
    expect(result.stitched).toBe(true);
  });

  it('orderId with no stitch-map row resolves to honest no_data (never reads the serving tier)', async () => {
    setupStitchAnons([]); // order has no stitched anon
    setupRows(TOUCH_ROWS); // would be non-empty if the serving read ran
    const result = await computeTouchpointTimeline(BRAND_ID, { srPool: {} as never, pool: {} as never }, { orderId: 'order-x' });
    expect(result.hasData).toBe(false);
    expect(result.touches).toEqual([]);
    expect(withSilverBrandMock).not.toHaveBeenCalled();
  });

  it('orderId with no PG pool degrades to honest no_data (stitch map is PG-native)', async () => {
    setupRows(TOUCH_ROWS);
    const result = await computeTouchpointTimeline(BRAND_ID, fakeDeps, { orderId: 'order-1' });
    expect(result.hasData).toBe(false);
    expect(result.touches).toEqual([]);
  });

  it('stitched=false when no touch is stitched (un-stitched anon journey is honest)', async () => {
    setupRows([
      { ...TOUCH_ROWS[0], stitched_brain_id: null },
      { ...TOUCH_ROWS[1], stitched_brain_id: null },
    ]);
    const result = await computeTouchpointTimeline(BRAND_ID, fakeDeps, { brainAnonId: 'anon-x' });
    expect(result.hasData).toBe(true);
    expect(result.stitched).toBe(false);
  });

  it('touchSeq is an integer (count, never float)', async () => {
    setupRows(TOUCH_ROWS);
    const result = await computeTouchpointTimeline(BRAND_ID, fakeDeps, { brainAnonId: 'anon-x' });
    for (const t of result.touches) expect(Number.isInteger(t.touchSeq)).toBe(true);
  });

  it('reads through the seam with the SESSION brandId (tenant-scoped; D-1)', async () => {
    setupStitchAnons(['anon-x']);
    const captured = captureBrand(TOUCH_ROWS);
    await computeTouchpointTimeline(BRAND_ID, { srPool: {} as never, pool: {} as never }, { orderId: 'order-1' });
    expect(captured.brandId).toBe(BRAND_ID);
  });
});
