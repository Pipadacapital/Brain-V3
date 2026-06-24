/**
 * storefront-engagement.live.test.ts — computeStorefrontEngagement against live StarRocks (Phase H).
 *
 * Proves the engagement-depth rollup over brain_silver.silver_touchpoint via the withSilverBrand seam:
 *   - sessions / touches / engaged (multi-touch) / bounce (single-touch),
 *   - engagement_rate + bounce_rate (percent, 2dp) + avg_touches_per_session (ratio, 2dp),
 *   - honest no_data when zero sessions, and per-brand isolation at the seam (BRAND_PREDICATE).
 *
 * Provisions a representative silver_touchpoint (IF NOT EXISTS — never clobbers a dbt-built table).
 * SKIPs if StarRocks is down. REQUIRES: StarRocks on :9030.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { computeStorefrontEngagement } from './storefront-engagement.js';
import type { SilverPool } from './silver-deps.js';

const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);

const BRAND_A = 'fee30a1a-0a1a-0a1a-0a1a-000000000001';
const BRAND_B = 'fee30a1a-0a1a-0a1a-0a1a-000000000002';
const TS = '2026-06-20 10:00:00';
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-30T23:59:59Z') };

let srPool: mysql.Pool;
let srUp = false;
const deps = () => ({ srPool: srPool as unknown as SilverPool });

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS brain_silver.silver_touchpoint (
  brand_id VARCHAR(64) NOT NULL, brain_anon_id VARCHAR(128) NOT NULL, touch_seq BIGINT NOT NULL,
  session_key INT, session_seq BIGINT, is_first_touch BOOLEAN, is_last_touch BOOLEAN,
  occurred_at DATETIME, event_type VARCHAR(64), channel VARCHAR(32),
  utm_source VARCHAR(255), utm_medium VARCHAR(255), utm_campaign VARCHAR(255), utm_term VARCHAR(255), utm_content VARCHAR(255),
  fbclid VARCHAR(255), gclid VARCHAR(255), ttclid VARCHAR(255), referrer_host VARCHAR(255), landing_path VARCHAR(512),
  page_type VARCHAR(32), product_handle VARCHAR(255), collection_handle VARCHAR(255), search_query VARCHAR(255),
  stitched_order_id VARCHAR(128), stitched_brain_id VARCHAR(64), is_synthetic BOOLEAN, session_id_raw VARCHAR(128), updated_at DATETIME
)
DUPLICATE KEY(brand_id, brain_anon_id, touch_seq)
DISTRIBUTED BY HASH(brand_id) BUCKETS 1
PROPERTIES ("replication_num" = "1")`;

let seq = 0;
async function seedTouch(brandId: string, sessionKey: number): Promise<void> {
  if (!srUp) return;
  seq += 1;
  await srPool.query(
    `INSERT INTO brain_silver.silver_touchpoint
       (brand_id, brain_anon_id, touch_seq, session_key, occurred_at, event_type, updated_at)
     VALUES (?, ?, ?, ?, ?, 'page.viewed', NOW())`,
    [brandId, `anon-${sessionKey}`, seq, sessionKey, TS],
  );
}

async function clear(brandId: string): Promise<void> {
  if (srUp) await srPool.query(`DELETE FROM brain_silver.silver_touchpoint WHERE brand_id = ?`, [brandId]);
}

beforeAll(async () => {
  try {
    srPool = mysql.createPool({ host: SR_HOST, port: SR_PORT, user: 'root', password: '', connectionLimit: 3 });
    await srPool.query('SELECT 1');
    await srPool.query(CREATE_TABLE);
    srUp = true;
  } catch {
    srUp = false;
  }
  await clear(BRAND_A);
  await clear(BRAND_B);
  // BRAND_A: session 1 = 1 touch (bounce), session 2 = 3 touches (engaged), session 3 = 2 touches (engaged).
  await seedTouch(BRAND_A, 1);
  await seedTouch(BRAND_A, 2);
  await seedTouch(BRAND_A, 2);
  await seedTouch(BRAND_A, 2);
  await seedTouch(BRAND_A, 3);
  await seedTouch(BRAND_A, 3);
});

afterAll(async () => {
  await clear(BRAND_A);
  await clear(BRAND_B);
  if (srPool) await srPool.end().catch(() => {});
});

describe('computeStorefrontEngagement (live StarRocks)', () => {
  it('SKIP_IF_NO_STARROCKS', () => {
    if (!srUp) console.warn('[engagement] StarRocks unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('computes engaged vs bounce + avg touches', async () => {
    if (!srUp) return;
    const r = await computeStorefrontEngagement(BRAND_A, deps(), RANGE);
    expect(r.hasData).toBe(true);
    expect(r.sessions).toBe(3n);
    expect(r.touches).toBe(6n);
    expect(r.engagedSessions).toBe(2n);   // sessions 2 and 3
    expect(r.bounceSessions).toBe(1n);    // session 1
    expect(r.engagementRatePct).toBe('66.66'); // 2/3
    expect(r.bounceRatePct).toBe('33.33');     // 1/3
    expect(r.avgTouchesPerSession).toBe('2.00'); // 6/3
  });

  it('honest no_data when no sessions in the window', async () => {
    if (!srUp) return;
    const r = await computeStorefrontEngagement(BRAND_B, deps(), RANGE);
    expect(r.hasData).toBe(false);
    expect(r.sessions).toBe(0n);
  });

  it('isolation — BRAND_A sessions invisible to BRAND_B (seam BRAND_PREDICATE)', async () => {
    if (!srUp) return;
    const r = await computeStorefrontEngagement(BRAND_B, deps(), RANGE);
    expect(r.hasData).toBe(false);
  });
});
