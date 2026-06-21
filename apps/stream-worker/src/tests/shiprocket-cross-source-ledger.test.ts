/**
 * shiprocket-cross-source-ledger.test.ts — the cross-source no-double-booking guarantee (SPEC 3),
 * infra-free.
 *
 * GoKwik (AWB feed) and Shiprocket (tracking feed) both populate the shared logistics canonical
 * surface and both feed the SAME CoD/RTO ledger via ShipmentLedgerConsumer. The guarantee: if BOTH
 * sources report a terminal RTO for the SAME (brand, order), the ledger writes the cod_rto_clawback
 * EXACTLY ONCE.
 *
 * Two layers establish that guarantee:
 *   1. (HERE) Both mappers converge on IDENTICAL ledger-relevant intent for the same order — same
 *      terminal_class='rto', is_terminal, order_id, payment gate. So the consumer derives the SAME
 *      ledger write (brand, order, event_type='cod_rto_clawback') from either source.
 *   2. The LedgerWriter dedup key (brand_id, order_id, event_type, date) + ON CONFLICT DO NOTHING
 *      collapses those identical writes to one row (proven end-to-end by gokwik-awb-repull.e2e.test.ts,
 *      same writer + same event_type).
 *
 * This test pins layer 1 (the deterministic convergence) without infra.
 */

import { describe, it, expect } from 'vitest';
import { mapGokwikAwb } from '@brain/gokwik-mapper';
import { mapShiprocketShipment } from '@brain/shiprocket-mapper';

const BRAND = '124e6af5-0000-0000-0000-000000000001';
const SALT = '8cc152f6'.repeat(8); // 64-char hex
const ORDER = 'shared_order_42';

describe('cross-source RTO convergence (no double-booking)', () => {
  it('GoKwik AWB RTO and Shiprocket shipment RTO for the same order yield identical ledger intent', () => {
    const gk = mapGokwikAwb(
      {
        awb_number: 'GK-AWB-1',
        order_id: ORDER,
        status: 'RTO Delivered',
        status_changed_at: '2026-06-12T16:45:00.000Z',
        payment_method: 'cod',
        pincode: '110001',
      },
      BRAND,
      SALT,
      'synthetic',
    );

    const sr = mapShiprocketShipment(
      {
        awb: 'SR-AWB-9',
        order_id: ORDER,
        status: 'RTO Delivered',
        status_changed_at: '2026-06-12T18:00:00.000Z',
        payment_method: 'cod',
        pincode: '110001',
        courier: 'Xpressbees',
      },
      BRAND,
      SALT,
      'synthetic',
    );

    // Identical ledger-relevant intent → ShipmentLedgerConsumer derives the SAME cod_rto_clawback
    // write from either source; the ledger dedup key then collapses them to one row.
    expect(gk.properties.terminal_class).toBe('rto');
    expect(sr.properties.terminal_class).toBe('rto');
    expect(gk.properties.is_terminal).toBe(true);
    expect(sr.properties.is_terminal).toBe(true);
    expect(gk.properties.order_id).toBe(sr.properties.order_id);
    expect(gk.properties.payment_method).toBe('cod');
    expect(sr.properties.payment_method).toBe('cod');
    // Distinct source provenance (so Bronze keeps both raw rows) but identical ledger key.
    expect(gk.properties.source).toBe('gokwik');
    expect(sr.properties.source).toBe('shiprocket');
  });

  it('a prepaid RTO from either source carries payment_method=prepaid (consumer skips the clawback)', () => {
    const sr = mapShiprocketShipment(
      { awb: 'SR-PP-1', order_id: 'pp_order', status: 'RTO Initiated', payment_method: 'prepaid' },
      BRAND,
      SALT,
    );
    expect(sr.properties.terminal_class).toBe('rto');
    expect(sr.properties.payment_method).toBe('prepaid');
  });
});
