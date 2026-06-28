/**
 * shiprocket-client.test.ts — UT for the dual-mode Shiprocket client (infra-free).
 *
 * Live mode (SHIPROCKET_LIVE=1) with a stubbed global fetch covering BOTH the login (→ JWT) and the
 * shipments read: asserts Bearer auth, data_source='real', defensive field mapping, pagination, and
 * SHIPROCKET_AUTH_ERROR + token-invalidate on 401. Fixture mode covered separately.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { ShiprocketShipmentClient, SHIPROCKET_SHIPMENT_PAGE_SIZE } from '../jobs/shiprocket-shipment-repull/shiprocket-client.js';
import { SHIPROCKET_AUTH_ERROR } from '../jobs/shiprocket-shipment-repull/shiprocket-token-provider.js';

const CREDS = { email: 'api@store.example', password: 'secret' };
const FROM = Math.floor(Date.parse('2026-06-01T00:00:00Z') / 1000);
const TO = Math.floor(Date.parse('2026-06-21T00:00:00Z') / 1000);

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env['SHIPROCKET_LIVE'];
});

describe('ShiprocketShipmentClient — live HTTP mode', () => {
  it('mints a JWT then reads shipments with Bearer auth, mapping fields defensively → data_source=real', async () => {
    process.env['SHIPROCKET_LIVE'] = '1';
    const seen: { url: string; auth: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers['Authorization'] ?? '' });
      if (url.includes('/v1/external/auth/login')) {
        return { ok: true, status: 200, json: async () => ({ token: 'jwt-abc' }) } as unknown as Response;
      }
      // shipments list — uses Shiprocket-flavored field names (awb_code, channel_order_id, current_status)
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { awb_code: 'SR1', channel_order_id: 'ORD-1', current_status: 'RTO Delivered', updated_at: '2026-06-12T10:00:00', courier_name: 'Delhivery', customer_pincode: '110001' },
          ],
        }),
      } as unknown as Response;
    }));

    const client = new ShiprocketShipmentClient(CREDS);
    const page = await client.fetchShipmentPage(FROM, TO, 0);

    expect(page.dataSource).toBe('real');
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ awb: 'SR1', order_id: 'ORD-1', status: 'RTO Delivered', courier: 'Delhivery', pincode: '110001' });
    expect(page.hasMore).toBe(false); // 1 < PAGE_SIZE
    // login happened first, shipments call carried the Bearer token
    expect(seen[0]!.url).toContain('/v1/external/auth/login');
    const shipmentsCall = seen.find((s) => !s.url.includes('/auth/login'))!;
    expect(shipmentsCall.auth).toBe('Bearer jwt-abc');
    expect(shipmentsCall.url).toContain('per_page=' + SHIPROCKET_SHIPMENT_PAGE_SIZE);
  });

  it('throws SHIPROCKET_AUTH_ERROR on a 401 shipments response', async () => {
    process.env['SHIPROCKET_LIVE'] = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/v1/external/auth/login')) {
        return { ok: true, status: 200, json: async () => ({ token: 'jwt-abc' }) } as unknown as Response;
      }
      return { ok: false, status: 401, json: async () => ({}) } as unknown as Response;
    }));

    const client = new ShiprocketShipmentClient(CREDS);
    await expect(client.fetchShipmentPage(FROM, TO, 0)).rejects.toThrow(SHIPROCKET_AUTH_ERROR);
  });
});

describe('ShiprocketShipmentClient — dev fixture mode (default)', () => {
  it('reads the synthetic fixture and stamps data_source=synthetic', async () => {
    const fromOld = Math.floor(Date.parse('2026-01-01T00:00:00Z') / 1000);
    const toNow = Math.floor(Date.parse('2026-12-31T00:00:00Z') / 1000);
    const client = new ShiprocketShipmentClient(CREDS);
    const page = await client.fetchShipmentPage(fromOld, toNow, 0);
    expect(page.dataSource).toBe('synthetic');
    expect(page.items.length).toBeGreaterThan(0);
  });
});

// SR-7 — per-AWB DOCUMENTED tracking endpoint, used for historical backfill.
describe('ShiprocketShipmentClient — fetchShipmentByAwb (SR-7 backfill)', () => {
  it('fixture mode: returns every scan recorded for the AWB', async () => {
    const client = new ShiprocketShipmentClient(CREDS);
    const scans = await client.fetchShipmentByAwb('SR-SYNTH-DELIVERED-0001');
    expect(scans.length).toBeGreaterThan(0);
    expect(scans.every((s) => s.awb === 'SR-SYNTH-DELIVERED-0001')).toBe(true);
    // the full lifecycle is present (e.g. the terminal Delivered scan)
    expect(scans.some((s) => s.status === 'Delivered')).toBe(true);
  });

  it('live mode: maps tracking_data.shipment_track_activities[] → one record per scan with Bearer auth', async () => {
    process.env['SHIPROCKET_LIVE'] = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.includes('/v1/external/auth/login')) {
        return { ok: true, status: 200, json: async () => ({ token: 'jwt-trk' }) } as unknown as Response;
      }
      expect(url).toContain('/v1/external/courier/track/awb/AWB-9');
      expect(init.headers['Authorization']).toBe('Bearer jwt-trk');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tracking_data: {
            shipment_track: [
              { channel_order_id: 'ORD-9', courier_name: 'BlueDart', destination_pin: '560001' },
            ],
            shipment_track_activities: [
              { date: '2026-06-05 08:00:00', activity: 'Pickup Scheduled' },
              { date: '2026-06-07 14:00:00', status: 'Delivered' },
            ],
          },
        }),
      } as unknown as Response;
    }));

    const client = new ShiprocketShipmentClient(CREDS);
    const scans = await client.fetchShipmentByAwb('AWB-9');
    expect(scans).toHaveLength(2);
    expect(scans[0]).toMatchObject({ awb: 'AWB-9', order_id: 'ORD-9', status: 'Pickup Scheduled', courier: 'BlueDart', pincode: '560001' });
    expect(scans[1]).toMatchObject({ awb: 'AWB-9', status: 'Delivered' });
  });

  it('live mode: throws SHIPROCKET_AUTH_ERROR on a 403 tracking response', async () => {
    process.env['SHIPROCKET_LIVE'] = '1';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/v1/external/auth/login')) {
        return { ok: true, status: 200, json: async () => ({ token: 'jwt-trk' }) } as unknown as Response;
      }
      return { ok: false, status: 403, json: async () => ({}) } as unknown as Response;
    }));
    const client = new ShiprocketShipmentClient(CREDS);
    await expect(client.fetchShipmentByAwb('AWB-X')).rejects.toThrow(SHIPROCKET_AUTH_ERROR);
  });
});
