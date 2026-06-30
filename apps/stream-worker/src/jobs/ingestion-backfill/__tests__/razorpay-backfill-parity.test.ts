/**
 * razorpay-backfill-parity.test.ts — REVENUE-TRUTH guard: the generic ingestion-backfill fetcher must
 * mint the SAME Bronze event_id as the live razorpay-settlement-repull lane for the same settlement
 * recon item.
 *
 * THE BUG this locks down: the generic backfill used to derive event_id from a composite tuple
 * (settlement_id, payment_id_hash, entity_type) under the framework's OWN namespace, which is NOT
 * byte-identical to the live lane's `uuidV5FromSettlementItem(brandId, settlementId, rawPaymentId,
 * entityType)` / `uuidV5FromSettlementSummary(brandId, settlementId)` seeds. Same record → two ids →
 * Bronze can't dedup → backfilled history DOUBLE-COUNTS against live settlement data.
 *
 * THE FIX (proven here): the fetcher now PRECOMPUTES providerId by CALLING the exact id fns the live
 * lane uses (razorpay-settlement-repull/run.ts repullCursorResource), with the SAME RAW arg values
 * (raw settlement_id + raw payment_id — NOT the hashed id). This test builds representative raw recon
 * items, runs them through the fetcher's fetchPage (with a stubbed RazorpaySettlementsClient so no
 * network is touched), and asserts the resulting FetchedRecord.providerId EQUALS the id the LIVE lane
 * would compute for that same item — for BOTH the per-payment (Item) and brand-level (Summary) grains.
 */
import { describe, it, expect } from 'vitest';
import {
  mapSettlementItemToEvent,
  uuidV5FromSettlementItem,
  uuidV5FromSettlementSummary,
  type RazorpaySettlementItem,
  type SettlementEntityType,
} from '@brain/razorpay-mapper';
import { buildRazorpayResourceFetcher } from '../razorpay-resource-fetchers.js';
import type { RazorpayReconItem } from '../../razorpay-settlement-repull/razorpay-settlements-client.js';

const BRAND_ID = '11111111-1111-4111-8111-111111111111';
// 64-char hex per-brand salt. The mapper uses it to hash payment_id/utr, but the id fns key off the
// RAW values — so the salt does NOT affect the event_id (parity holds regardless).
const SALT_HEX = 'a'.repeat(64);

/** Representative raw per-payment recon item (entity_type 'payment', has a raw payment_id). */
const RAW_PAYMENT_ITEM: RazorpayReconItem = {
  settlement_id: 'setl_PAY00001',
  payment_id: 'pay_ABC123XYZ',
  order_id: 'order_OO1',
  amount: 123456,
  fee: 2345,
  tax: 422,
  utr: 'UTR0001',
  status: 'processed',
  created_at: 1_717_200_000,
  settled_at: 1_717_286_400,
  currency: 'INR',
  entity_type: 'payment',
};

/** Representative raw brand-level recon item (entity_type 'reserve_deduction', NO payment_id). */
const RAW_RESERVE_ITEM: RazorpayReconItem = {
  settlement_id: 'setl_RSV00009',
  payment_id: null,
  amount: 50000,
  fee: 0,
  tax: 0,
  status: 'processed',
  created_at: 1_717_200_000,
  settled_at: 1_717_286_400,
  currency: 'INR',
  entity_type: 'reserve_deduction',
};

/** Override the fetcher's private RazorpaySettlementsClient with a stub returning fixed items (no network). */
function stubClientOnto(fetcher: object, items: RazorpayReconItem[]): void {
  const fakeClient = {
    async fetchAllReconItems(): Promise<RazorpayReconItem[]> {
      return items;
    },
  };
  (fetcher as unknown as { client: typeof fakeClient }).client = fakeClient;
}

/**
 * Compute the event_id EXACTLY as the live razorpay-settlement-repull lane does
 * (repullCursorResource), from the RAW recon item.
 */
function liveLaneEventId(rawItem: RazorpayReconItem): string {
  const mapped = mapSettlementItemToEvent(rawItem as RazorpaySettlementItem, BRAND_ID, SALT_HEX);
  const settlementId = rawItem.settlement_id ? String(rawItem.settlement_id) : '';
  const rawPaymentId = rawItem.payment_id ? String(rawItem.payment_id) : null;
  const entityType = mapped.properties.entity_type as SettlementEntityType;
  const isBrandLevel = mapped.properties.reconciliation_type === 'brand_level';
  return isBrandLevel || !rawPaymentId
    ? uuidV5FromSettlementSummary(BRAND_ID, settlementId)
    : uuidV5FromSettlementItem(BRAND_ID, settlementId, rawPaymentId, entityType);
}

describe('razorpay backfill → live event_id parity (revenue-truth dedup)', () => {
  it('per-payment item: fetcher providerId == uuidV5FromSettlementItem(...) with the live lane args', async () => {
    const fetcher = buildRazorpayResourceFetcher({
      pool: {} as never,
      connectorInstanceId: 'ci-1',
      resource: 'settlements.payments',
      brandId: BRAND_ID,
      saltHex: SALT_HEX,
      secrets: { keyId: 'unused', keySecret: 'unused' },
    });
    stubClientOnto(fetcher, [RAW_PAYMENT_ITEM]);

    const page = await fetcher.fetchPage({
      resource: { name: 'settlements.payments' } as never,
      cursor: null,
      floorAt: new Date('2020-01-01T00:00:00Z'),
    });

    expect(page.records.length).toBe(1);
    const record = page.records[0]!;

    // EXPECTED = exactly what the live lane computes (per-payment → uuidV5FromSettlementItem).
    const expected = uuidV5FromSettlementItem(BRAND_ID, 'setl_PAY00001', 'pay_ABC123XYZ', 'payment');
    expect(liveLaneEventId(RAW_PAYMENT_ITEM)).toBe(expected); // sanity: the test mirror matches the fn
    expect(record.providerId).toBe(expected);
    // Identity now flows through providerId — no framework composite tuple.
    expect(record.compositeValues).toBeUndefined();
  });

  it('brand-level item: fetcher providerId == uuidV5FromSettlementSummary(...) with the live lane args', async () => {
    const fetcher = buildRazorpayResourceFetcher({
      pool: {} as never,
      connectorInstanceId: 'ci-1',
      resource: 'settlements.reserves',
      brandId: BRAND_ID,
      saltHex: SALT_HEX,
      secrets: { keyId: 'unused', keySecret: 'unused' },
    });
    stubClientOnto(fetcher, [RAW_RESERVE_ITEM]);

    const page = await fetcher.fetchPage({
      resource: { name: 'settlements.reserves' } as never,
      cursor: null,
      floorAt: new Date('2020-01-01T00:00:00Z'),
    });

    expect(page.records.length).toBe(1);
    const record = page.records[0]!;

    // EXPECTED = exactly what the live lane computes (brand-level / no payment → Summary).
    const expected = uuidV5FromSettlementSummary(BRAND_ID, 'setl_RSV00009');
    expect(liveLaneEventId(RAW_RESERVE_ITEM)).toBe(expected); // sanity: the test mirror matches the fn
    expect(record.providerId).toBe(expected);
    expect(record.compositeValues).toBeUndefined();
  });
});
