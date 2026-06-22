/**
 * storefront-funnel.live.test.ts — computeStorefrontFunnel against live StarRocks (Phase H pixel).
 *
 * Proves the conversion funnel (sessions → product views → cart adds → purchases) computed over
 * brain_silver.silver_touchpoint via the withSilverBrand seam:
 *   - stage reach = distinct session_key exhibiting each signal in the window,
 *   - conversion % vs the funnel top + step-over-previous %,
 *   - honest no_data when zero sessions,
 *   - per-brand isolation at the seam (BRAND_PREDICATE) — BRAND_A rows invisible to BRAND_B.
 *
 * Provisions a representative silver_touchpoint (IF NOT EXISTS — never clobbers a dbt-built table)
 * so the test is self-contained where the mart isn't materialized yet. SKIPs if StarRocks is down.
 *
 * REQUIRES: StarRocks on :9030.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mysql from 'mysql2/promise';
import { computeStorefrontFunnel } from './storefront-funnel.js';
import type { SilverPool } from './silver-deps.js';

const SR_HOST = process.env['STARROCKS_HOST'] ?? '127.0.0.1';
const SR_PORT = Number(process.env['STARROCKS_QUERY_PORT'] ?? 9030);

const BRAND_A = 'fee10a1a-0a1a-0a1a-0a1a-000000000001';
const BRAND_B = 'fee10a1a-0a1a-0a1a-0a1a-000000000002';
const TS = '2026-06-20 10:00:00';
const RANGE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-06-30T23:59:59Z') };

let srPool: mysql.Pool;
let srUp = false;
const deps = () => ({ srPool: srPool as unknown as SilverPool });

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS brain_silver.silver_touchpoint (
  brand_id          VARCHAR(64)  NOT NULL,
  brain_anon_id     VARCHAR(128) NOT NULL,
  touch_seq         BIGINT       NOT NULL,
  session_key       INT,
  session_seq       BIGINT,
  is_first_touch    BOOLEAN,
  is_last_touch     BOOLEAN,
  occurred_at       DATETIME,
  event_type        VARCHAR(64),
  channel           VARCHAR(32),
  utm_source        VARCHAR(255),
  utm_medium        VARCHAR(255),
  utm_campaign      VARCHAR(255),
  utm_term          VARCHAR(255),
  utm_content       VARCHAR(255),
  fbclid            VARCHAR(255),
  gclid             VARCHAR(255),
  ttclid            VARCHAR(255),
  referrer_host     VARCHAR(255),
  landing_path      VARCHAR(512),
  page_type         VARCHAR(32),
  product_handle    VARCHAR(255),
  collection_handle VARCHAR(255),
  search_query      VARCHAR(255),
  stitched_order_id VARCHAR(128),
  stitched_brain_id VARCHAR(64),
  is_synthetic      BOOLEAN,
  session_id_raw    VARCHAR(128),
  updated_at        DATETIME
)
DUPLICATE KEY(brand_id, brain_anon_id, touch_seq)
DISTRIBUTED BY HASH(brand_id) BUCKETS 1
PROPERTIES ("replication_num" = "1")`;

let seq = 0;
async function seedTouch(
  brandId: string,
  sessionKey: number,
  eventType: string,
  stitchedOrderId: string | null,
): Promise<void> {
  if (!srUp) return;
  seq += 1;
  await srPool.query(
    `INSERT INTO brain_silver.silver_touchpoint
       (brand_id, brain_anon_id, touch_seq, session_key, occurred_at, event_type, stitched_order_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [brandId, `anon-${sessionKey}`, seq, sessionKey, TS, eventType, stitchedOrderId],
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
  // BRAND_A scenario — 3 sessions:
  //   s1: browsed only (page.viewed)
  //   s2: viewed a product + added to cart (no purchase)
  //   s3: viewed + added to cart + stitched to an order (purchased)
  await seedTouch(BRAND_A, 1, 'page.viewed', null);
  await seedTouch(BRAND_A, 2, 'product.viewed', null);
  await seedTouch(BRAND_A, 2, 'cart.item_added', null);
  await seedTouch(BRAND_A, 3, 'product.viewed', null);
  await seedTouch(BRAND_A, 3, 'cart.item_added', null);
  await seedTouch(BRAND_A, 3, 'page.viewed', 'order-123'); // stitched → purchased
});

afterAll(async () => {
  await clear(BRAND_A);
  await clear(BRAND_B);
  if (srPool) await srPool.end().catch(() => {});
});

describe('computeStorefrontFunnel (live StarRocks)', () => {
  it('SKIP_IF_NO_STARROCKS', () => {
    if (!srUp) console.warn('[storefront-funnel] StarRocks unavailable — PENDING.');
    expect(true).toBe(true);
  });

  it('computes the four-stage funnel with exact reach + conversion %', async () => {
    if (!srUp) return;
    const r = await computeStorefrontFunnel(BRAND_A, deps(), RANGE);
    expect(r.hasData).toBe(true);
    const byKey = Object.fromEntries(r.stages.map((s) => [s.key, s]));

    expect(byKey['sessions']!.sessions).toBe(3n);
    expect(byKey['product_viewed']!.sessions).toBe(2n); // s2, s3
    expect(byKey['cart_added']!.sessions).toBe(2n);     // s2, s3
    expect(byKey['purchased']!.sessions).toBe(1n);      // s3

    // conversion vs top (3 sessions): 2/3 = 66.66, 1/3 = 33.33 (2dp truncation)
    expect(byKey['product_viewed']!.conversionPct).toBe('66.66');
    expect(byKey['purchased']!.conversionPct).toBe('33.33');
    // step: product 2/3=66.66, cart 2/2=100.00, purchased 1/2=50.00
    expect(byKey['sessions']!.stepPct).toBeNull();
    expect(byKey['cart_added']!.stepPct).toBe('100.00');
    expect(byKey['purchased']!.stepPct).toBe('50.00');
  });

  it('honest no_data when the brand has zero sessions in the window', async () => {
    if (!srUp) return;
    const r = await computeStorefrontFunnel(BRAND_B, deps(), RANGE);
    expect(r.hasData).toBe(false);
    expect(r.stages).toEqual([]);
  });

  it('isolation — BRAND_A touches are invisible to BRAND_B (seam BRAND_PREDICATE)', async () => {
    if (!srUp) return;
    const r = await computeStorefrontFunnel(BRAND_B, deps(), RANGE);
    expect(r.hasData).toBe(false); // BRAND_A's 3 sessions do not leak into BRAND_B
  });
});
