/**
 * @brain/shiprocket-mapper — UT: canonical mapping + boundary hash + deterministic id.
 */

import { describe, it, expect } from 'vitest';
import {
  mapShiprocketShipment,
  uuidV5FromShipment,
  hashAwbNumber,
  SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
} from '../index.js';

const BRAND = '124e6af5-0000-0000-0000-000000000001';
const SALT = '8cc152f6'.repeat(8); // 64-char hex

describe('mapShiprocketShipment', () => {
  it('maps a terminal RTO shipment to the canonical shape (rto class, hashed awb, order passthrough)', () => {
    const ev = mapShiprocketShipment(
      {
        awb: 'SR123456789',
        order_id: 'ORD-1',
        status: 'RTO Initiated',
        status_changed_at: '2026-06-20T10:00:00.000Z',
        payment_method: 'COD',
        pincode: '560001',
        courier: 'Delhivery',
      },
      BRAND,
      SALT,
      'synthetic',
    );
    expect(ev.event_name).toBe(SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME);
    expect(ev.properties.source).toBe('shiprocket');
    expect(ev.properties.data_source).toBe('synthetic');
    expect(ev.properties.terminal_class).toBe('rto');
    expect(ev.properties.is_terminal).toBe(true);
    expect(ev.properties.order_id).toBe('ORD-1');
    expect(ev.properties.payment_method).toBe('cod');
    expect(ev.properties.courier).toBe('Delhivery');
    expect(ev.properties.awb_number_hash).toBe(hashAwbNumber('SR123456789', SALT));
    // raw awb must NOT appear anywhere in the output
    expect(JSON.stringify(ev)).not.toContain('SR123456789');
  });

  it('classifies Delivered as delivered and forward states as non-terminal', () => {
    expect(
      mapShiprocketShipment({ order_id: 'O', status: 'Delivered' }, BRAND, SALT).properties.terminal_class,
    ).toBe('delivered');
    expect(
      mapShiprocketShipment({ order_id: 'O', status: 'In-Transit' }, BRAND, SALT).properties.is_terminal,
    ).toBe(false);
  });

  it('throws when order_id (ledger spine key) is missing', () => {
    expect(() => mapShiprocketShipment({ status: 'Delivered' }, BRAND, SALT)).toThrow(/order_id/);
  });
});

describe('uuidV5FromShipment', () => {
  it('is deterministic and distinct per transition', () => {
    const a = uuidV5FromShipment(BRAND, 'AWB', 'RTO Initiated', '2026-06-20T10:00:00.000Z');
    const a2 = uuidV5FromShipment(BRAND, 'AWB', 'RTO Initiated', '2026-06-20T10:00:00.000Z');
    const b = uuidV5FromShipment(BRAND, 'AWB', 'Delivered', '2026-06-20T10:00:00.000Z');
    expect(a).toBe(a2);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
