/**
 * @brain/shiprocket-mapper — UT: canonical mapping + boundary hash + deterministic id.
 */

import { describe, it, expect } from 'vitest';
import {
  mapShiprocketShipment,
  mapShiprocketReturn,
  uuidV5FromShipment,
  uuidV5FromReturn,
  hashAwbNumber,
  SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME,
  SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME,
} from '../index.js';
import { hashIdentifier, normalizePhone } from '@brain/identity-core';

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

// ── SR-4: return mapper — the false-delivery fix ─────────────────────────────────────────────────
describe('mapShiprocketReturn', () => {
  it('CRITICAL: return.completed maps to the RETURN lane (return_completed), NEVER a forward DELIVERED', () => {
    const ev = mapShiprocketReturn(
      { awb: 'SR999', order_id: 'ORD-9', status: 'completed', status_changed_at: '2026-06-21T10:00:00.000Z' },
      BRAND,
      SALT,
      'synthetic',
    );
    expect(ev.event_name).toBe(SHIPROCKET_RETURN_STATUS_V1_EVENT_NAME);
    expect(ev.event_name).not.toBe(SHIPROCKET_SHIPMENT_STATUS_V1_EVENT_NAME);
    expect(ev.properties.return_class).toBe('return_completed');
    expect(ev.properties.is_return_complete).toBe(true);
    // The return event carries NO terminal_class — it can never leak a false 'delivered' into the ledger.
    expect((ev.properties as unknown as Record<string, unknown>)['terminal_class']).toBeUndefined();
    expect(JSON.stringify(ev)).not.toContain('"delivered"');
  });

  it('maps the four return stages + drops raw awb', () => {
    expect(mapShiprocketReturn({ order_id: 'O', status: 'created' }, BRAND, SALT).properties.return_class).toBe('return_initiated');
    expect(mapShiprocketReturn({ order_id: 'O', status: 'picked_up' }, BRAND, SALT).properties.return_class).toBe('return_in_transit');
    expect(mapShiprocketReturn({ order_id: 'O', status: 'delivered' }, BRAND, SALT).properties.return_class).toBe('return_delivered');
    const ev = mapShiprocketReturn({ awb: 'RAWB1', order_id: 'O', status: 'created' }, BRAND, SALT);
    expect(ev.properties.awb_number_hash).toBe(hashAwbNumber('RAWB1', SALT));
    expect(JSON.stringify(ev)).not.toContain('RAWB1');
  });

  it('throws when order_id is missing', () => {
    expect(() => mapShiprocketReturn({ status: 'completed' }, BRAND, SALT)).toThrow(/order_id/);
  });
});

describe('uuidV5FromReturn — namespaced apart from the shipment lane', () => {
  it('a return transition and a shipment transition with the same key get DISTINCT ids', () => {
    const shipment = uuidV5FromShipment(BRAND, 'AWB', 'delivered', '2026-06-21T10:00:00.000Z');
    const ret = uuidV5FromReturn(BRAND, 'AWB', 'delivered', '2026-06-21T10:00:00.000Z');
    expect(ret).not.toBe(shipment);
    expect(ret).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── SR-5: exception_class on the forward shipment event ──────────────────────────────────────────
describe('mapShiprocketShipment — exception_class (SR-5)', () => {
  it('flags delayed/NDR as a NON-terminal exception (terminal_class stays none)', () => {
    const delayed = mapShiprocketShipment({ order_id: 'O', status: 'Delayed' }, BRAND, SALT).properties;
    expect(delayed.exception_class).toBe('delayed');
    expect(delayed.terminal_class).toBe('none');
    expect(delayed.is_terminal).toBe(false);

    const ndr = mapShiprocketShipment({ order_id: 'O', status: 'NDR' }, BRAND, SALT).properties;
    expect(ndr.exception_class).toBe('ndr');
    expect(ndr.is_terminal).toBe(false);
  });

  it('exception_class is null for normal forward + terminal states', () => {
    expect(mapShiprocketShipment({ order_id: 'O', status: 'In-Transit' }, BRAND, SALT).properties.exception_class).toBeNull();
    expect(mapShiprocketShipment({ order_id: 'O', status: 'Delivered' }, BRAND, SALT).properties.exception_class).toBeNull();
  });
});

// ── SR-6: hashed customer identity at the boundary ───────────────────────────────────────────────
describe('SR-6 — hashed customer identity (raw phone/email DROPPED)', () => {
  it('hashes phone + email with the same salt regime as identity-core; raw never in output', () => {
    const ev = mapShiprocketShipment(
      { order_id: 'O', status: 'Delivered', customer_email: 'A@Example.com', customer_phone: '9876543210' },
      BRAND,
      SALT,
      'real',
      'IN',
    );
    expect(ev.properties.hashed_customer_email).toBe(hashIdentifier('A@Example.com', 'email', SALT, 'IN'));
    const { normalized } = normalizePhone('9876543210', 'IN');
    expect(ev.properties.hashed_customer_phone).toBe(hashIdentifier(normalized, 'phone', SALT, 'IN'));
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain('A@Example.com');
    expect(serialized).not.toContain('9876543210');
  });

  it('omits the hashed fields entirely when identity is absent', () => {
    const ev = mapShiprocketShipment({ order_id: 'O', status: 'Delivered' }, BRAND, SALT);
    expect(ev.properties.hashed_customer_email).toBeUndefined();
    expect(ev.properties.hashed_customer_phone).toBeUndefined();
  });

  it('the return mapper hashes identity too', () => {
    const ev = mapShiprocketReturn(
      { order_id: 'O', status: 'completed', customer_phone: '9876543210' },
      BRAND,
      SALT,
      'real',
      'IN',
    );
    const { normalized } = normalizePhone('9876543210', 'IN');
    expect(ev.properties.hashed_customer_phone).toBe(hashIdentifier(normalized, 'phone', SALT, 'IN'));
  });
});
