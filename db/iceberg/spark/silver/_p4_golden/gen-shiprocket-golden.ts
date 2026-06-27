// gen-shiprocket-golden.ts — ADR-0006 P4 golden-vector generator for the Shiprocket normalizer.
//
// Runs the REAL @brain/shiprocket-mapper (mapShiprocketShipment + uuidV5FromShipment) on a few
// representative RAW shipment records with a FIXED salt, and dumps {raw -> expected canonical} JSON.
// The PySpark-side test (test_shiprocket-golden.py) then asserts the shared _raw_normalize ports
// (+ the connector-local logistics-status port) reproduce these expected fields byte-for-byte.
//
// This MIRRORS the shiprocket-shipment-repull job path (apps/stream-worker/.../shiprocket-shipment-repull/run.ts):
//   rawAwb    = record.awb ? String(record.awb) : ''        (untrimmed — the event_id seed component)
//   rawStatus = record.status ? String(record.status) : ''  (untrimmed — the event_id seed component)
//   statusChangedAt = mapped.properties.status_changed_at   (ISO-normalized via the mapper)
//   eventId   = uuidV5FromShipment(brandId, rawAwb, rawStatus, statusChangedAt)
// so the captured event_id is exactly what the connector stamps. (The vectors use whitespace-free
// awb/status so the seed is convention-stable regardless of trim.)
//
// Run:  pnpm --filter @brain/shiprocket-mapper exec tsx ../../db/iceberg/spark/silver/_p4_golden/gen-shiprocket-golden.ts > shiprocket-shipment-golden.json
//   (or any tsx with @brain/shiprocket-mapper resolvable) — then commit the JSON beside this file.
import { mapShiprocketShipment, uuidV5FromShipment } from '@brain/shiprocket-mapper';

const SALT = 'a'.repeat(64); // a fixed 64-hex salt for reproducible vectors
const BRAND = '444a25f2-57d4-4e04-9f70-98a6480e1fc4';
const DATA_SOURCE = 'real' as const;

const shipments: any[] = [
  { awb: 'SR123456789', order_id: 'ORD-1001', status: 'RTO Initiated', status_changed_at: '2026-06-20T10:00:00Z', payment_method: 'cod', pincode: '560001', courier: 'Delhivery' },
  { awb: 'SR987654321', order_id: 'ORD-1002', status: 'Delivered', status_changed_at: '2026-06-21T12:30:45Z', payment_method: 'prepaid', pincode: '110011', courier: 'Bluedart' },
  { awb: null, order_id: 'ORD-1003', status: 'In Transit', status_changed_at: '2026-06-22T08:15:00Z', payment_method: null, pincode: null, courier: null },
  { awb: 'SR555000111', order_id: 'ORD-1004', status: 'Returned', status_changed_at: '2026-06-23T06:00:00Z', payment_method: 'Cash on Delivery', pincode: '400001', courier: 'XpressBees' },
];

const vectors = shipments.map((s) => {
  const mapped = mapShiprocketShipment(s, BRAND, SALT, DATA_SOURCE);
  const rawAwb = s.awb ? String(s.awb) : '';
  const rawStatus = s.status ? String(s.status) : '';
  const statusChangedAt = mapped.properties.status_changed_at;
  const event_id = uuidV5FromShipment(BRAND, rawAwb, rawStatus, statusChangedAt);
  const p = mapped.properties;
  return {
    raw_shipment: s,
    brand_id: BRAND,
    salt_hex: SALT,
    data_source: DATA_SOURCE,
    expected: {
      event_id,
      occurred_at: mapped.occurred_at,
      status_changed_at: p.status_changed_at,
      awb_number_hash: p.awb_number_hash ?? null,
      order_id: p.order_id,
      status: p.status,
      terminal_class: p.terminal_class,
      is_terminal: p.is_terminal,
      payment_method: p.payment_method ?? null,
      pincode: p.pincode ?? null,
      courier: p.courier ?? null,
    },
  };
});

console.log(JSON.stringify(vectors, null, 2));
