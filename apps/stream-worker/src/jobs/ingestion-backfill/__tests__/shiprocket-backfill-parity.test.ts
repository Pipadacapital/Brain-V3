/**
 * shiprocket-backfill-parity.test.ts — REVENUE-TRUTH parity guard.
 *
 * Proves the Shiprocket BACKFILL fetcher mints a Bronze event_id that is BYTE-IDENTICAL to the
 * LIVE/repull lane's id for the same shipment-status transition. If they ever diverge, the same
 * logical fact gets two ids → Bronze cannot dedup → backfilled history DOUBLE-COUNTS against live
 * data (a revenue-truth violation). This test fails loudly the moment that drift is introduced.
 *
 * The live lane (apps/stream-worker/.../shiprocket-shipment-repull/run.ts) computes:
 *     uuidV5FromShipment(brandId, RAW awb, RAW status, mapped.properties.status_changed_at)
 * We reproduce EXACTLY that call here and assert the fetcher's FetchedRecord.providerId equals it.
 *
 * The Shiprocket client is mocked so the test is hermetic (no fixture/HTTP) — only the id derivation
 * (the real @brain/shiprocket-mapper) is under test.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  mapShiprocketShipment,
  uuidV5FromShipment,
  type ShiprocketShipmentRecord,
} from '@brain/shiprocket-mapper';
import { SHIPROCKET_SHIPMENT_LIFECYCLE_RESOURCE } from '@brain/connector-core';

const BRAND = '11111111-1111-1111-1111-111111111111';
const CONNECTOR = '99999999-9999-9999-9999-999999999999';
/** 64-char hex per-brand salt (AWB + identity boundary hashing). */
const SALT = 'ab'.repeat(32);

/** A representative raw Shiprocket shipment-status transition row. */
const RAW_RECORD: ShiprocketShipmentRecord = {
  awb: 'SR1234567890',
  order_id: 'ORD-1001',
  status: 'Delivered',
  status_changed_at: '2026-06-01T10:00:00.000Z',
  payment_method: 'prepaid',
  pincode: '560001',
  courier: 'Delhivery',
  customer_phone: '+919876543210',
  customer_email: 'buyer@example.com',
};

// Mock the live re-pull client so the fetcher's fetchPage returns our single raw record without any
// fixture/HTTP. Must mirror the real module's export surface (the fetcher re-exports PAGE_SIZE).
vi.mock('../../shiprocket-shipment-repull/shiprocket-client.js', () => ({
  SHIPROCKET_SHIPMENT_PAGE_SIZE: 200,
  ShiprocketShipmentClient: class {
    constructor(_creds: unknown) {}
    async fetchShipmentPage(): Promise<{
      items: ShiprocketShipmentRecord[];
      hasMore: boolean;
      dataSource: 'synthetic';
    }> {
      return { items: [RAW_RECORD], hasMore: false, dataSource: 'synthetic' };
    }
  },
}));

describe('shiprocket backfill ↔ live event_id parity', () => {
  it('fetcher.providerId === uuidV5FromShipment(...) the live lane computes', async () => {
    // Import AFTER the mock is registered so the fetcher binds the mocked client.
    const { buildShiprocketResourceFetcher } = await import('../shiprocket-resource-fetchers.js');

    // ── What the LIVE lane would derive for this exact record (run.ts lines 263-271) ──
    const rawAwb = RAW_RECORD.awb ? String(RAW_RECORD.awb) : '';
    const rawStatus = RAW_RECORD.status ? String(RAW_RECORD.status) : '';
    const liveMapped = mapShiprocketShipment(RAW_RECORD, BRAND, SALT, 'synthetic');
    const liveEventId = uuidV5FromShipment(
      BRAND,
      rawAwb,
      rawStatus,
      liveMapped.properties.status_changed_at,
    );

    // ── What the BACKFILL fetcher derives ──
    const fetcher = buildShiprocketResourceFetcher({
      pool: {} as never,
      connectorInstanceId: CONNECTOR,
      resource: 'shipment.lifecycle',
      brandId: BRAND,
      saltHex: SALT,
      secrets: { email: 'x', password: 'y' },
    });

    const page = await fetcher.fetchPage({
      resource: SHIPROCKET_SHIPMENT_LIFECYCLE_RESOURCE,
      cursor: null,
      floorAt: new Date('2024-01-01T00:00:00.000Z'),
    });

    expect(page.records).toHaveLength(1);
    const record = page.records[0]!;

    // THE PARITY ASSERTION: backfill id == live id, byte-for-byte → Bronze dedups → no double-count.
    expect(record.providerId).toBe(liveEventId);

    // And it carries the id via providerId (passthrough deriver), NOT a composite tuple.
    expect(record.compositeValues).toBeUndefined();
    // Sanity: it is a shaped UUID, and the event body still maps through the frozen mapper.
    expect(record.providerId).toMatch(/^[0-9a-f-]{36}$/);
    expect(record.events[0]!.event_name).toBe(liveMapped.event_name);
  });
});
